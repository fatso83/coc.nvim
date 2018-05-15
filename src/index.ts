// umask is blacklisted by node-client
process.umask = ()=> {
  return 18
}
import { Plugin, Autocmd, Function, Neovim } from 'neovim'
import {
  SourceStat,
  CompleteOption,
  VimCompleteItem} from './types'
import {
  wait,
  echoErr,
  isCocItem,
  contextDebounce} from './util/index'
import {
  setConfig,
  toggleSource,
  getConfig} from './config'
import buffers from './buffers'
import completes from './completes'
import remotes from './remotes'
import natives from './natives'
import remoteStore from './remote-store'
import Increment from './increment'
const logger = require('./util/logger')('index')

@Plugin({dev: false})
export default class CompletePlugin {
  public nvim: Neovim
  public increment: Increment
  private debouncedOnChange: (bufnr: string)=>void

  constructor(nvim: Neovim) {
    this.nvim = nvim
    this.debouncedOnChange = contextDebounce((bufnr: string) => {
      this.onBufferChange(bufnr).catch(e => {
        logger.error(e.message)
      })
      logger.debug(`buffer ${bufnr} change`)
    }, 500)
    this.increment = new Increment(nvim)
    process.on('unhandledRejection', (reason, p) => {
      logger.error('Unhandled Rejection at:', p, 'reason:', reason)
      if (reason instanceof Error) this.handleError(reason)
    })
    process.on('uncaughtException', this.handleError.bind(this))
    this.handleError = this.handleError.bind(this)
  }

  private handleError(err: Error):void {
    let {nvim} = this
    echoErr(nvim ,`Service error: ${err.message}`).catch(err => {
      logger.error(err.message)
    })
  }

  @Function('CocInitAsync', {sync: false})
  public async cocInitAsync():Promise<void> {
    this.onInit().catch(err => {
      logger.error(err.stack)
    })
  }

  @Function('CocInitSync', {sync: true})
  public async cocInitSync():Promise<void> {
    await this.onInit()
  }

  private async onInit(): Promise<void> {
    let {nvim} = this
    try {
      await this.initConfig()
      await natives.init()
      await remotes.init(nvim, natives.names)
      await nvim.command(`let g:coc_node_channel_id=${(nvim as any)._channel_id}`)
      await nvim.command('silent doautocmd User CocNvimInit')
      logger.info('Coc service Initailized')
      // required since BufRead triggered before VimEnter
      let bufs:number[] = await nvim.call('coc#util#get_buflist', [])
      for (let buf of bufs) {
        await buffers.addBuffer(nvim, buf.toString())
      }
    } catch (err) {
      logger.error(err.stack)
      return echoErr(nvim, `Initailize failed, ${err.message}`)
    }
  }

  @Function('CocBufUnload', {sync: false})
  public async cocBufUnload(args: any[]):Promise<void> {
    let bufnr = args[0].toString()
    buffers.removeBuffer(bufnr)
    logger.debug(`buffer ${bufnr} remove`)
  }

  @Function('CocBufChange', {sync: false})
  public async cocBufChange(args: any[]):Promise<void> {
    let bufnr = args[0].toString()
    this.debouncedOnChange(bufnr)
  }

  @Function('CocStart', {sync: false})
  public async cocStart(args: [CompleteOption]):Promise<void> {
    let opt = args[0]
    let start = Date.now()
    let {nvim, increment} = this
    await increment.stop()
    logger.debug(`options: ${JSON.stringify(opt)}`)
    let {filetype} = opt
    let complete = completes.createComplete(opt)
    let sources = await completes.getSources(nvim, filetype)
    complete.doComplete(sources).then(async ([startcol, items])=> {
      if (items.length == 0) {
        // no items found
        completes.reset()
        return
      }
      let first = items[0]
      increment.setOption(opt)
      // the first item not allowed for auto insert
      if (first.noinsert && items.length > 1) {
        increment.changedI = {
          linenr: opt.linenr,
          colnr: opt.colnr
        }
        await increment.start(opt.input, opt.input, false)
      }
      nvim.setVar('coc#_context', {
        start: startcol,
        candidates: items
      }).catch(this.handleError)
      nvim.call('coc#_do_complete', []).then(() => {
        logger.debug(`Complete time cost: ${Date.now() - start}ms`)
      }).catch(this.handleError)
      completes.calculateChars()
      this.onCompleteStart(opt).catch(this.handleError)
    }, this.handleError)
  }

  private async onCompleteStart(opt: CompleteOption):Promise<void> {
    let {linenr, input} = opt
    let {nvim, increment} = this
    await wait(50)
    let visible = await nvim.call('pumvisible')
    let [_, lnum, col] = await nvim.call('getpos', ['.'])
    if (visible != 1 || lnum != linenr) return
    if (increment.activted) return

    let line = await nvim.call('getline', ['.'])
    let word = col > opt.col ? line.slice(opt.col, col - 1): ''
    // let's start
    increment.changedI = {
      linenr: lnum,
      colnr: col
    }
    let completeOpt = getConfig('completeOpt')
    let hasInsert = !/noinsert/.test(completeOpt)
      // menu in completeopt, reset compelteopt, make vim insert
    await increment.start(input, word, hasInsert)
  }

  @Autocmd('InsertCharPre', {
    pattern: '*',
    sync: true,
  })
  public async cocCharInsert():Promise<void> {
    await this.increment.onCharInsert()
  }

  @Autocmd('CompleteDone', {
    pattern: '*',
    sync: true,
  })
  public async cocCompleteDone():Promise<void> {
    let {nvim, increment} = this
    let item:any = await nvim.getVvar('completed_item')
    if (!Object.keys(item).length) item = null
    let isCoc = isCocItem(item)
    logger.debug(`Item:${JSON.stringify(item)}`)
    if (increment.activted) {
      await increment.onCompleteDone(item as VimCompleteItem, isCoc)
    }
    if (item && isCoc) {
      completes.addRecent(item.word)
      if (item.user_data) {
        let data = JSON.parse(item.user_data)
        let source = await completes.getSource(nvim, data.source)
        if (source) {
          await source.onCompleteDone(item as VimCompleteItem)
        }
      }
    }
  }

  @Autocmd('InsertLeave', {
    pattern: '*',
    sync: true,
  })
  public async cocInsertLeave():Promise<void> {
    await this.increment.stop()
  }

  @Autocmd('TextChangedI', {
    pattern: '*',
    sync: true
  })
  public async cocTextChangeI():Promise<void> {
    let {complete} = completes
    let {nvim, increment} = this
    if (!complete) return
    let shouldStart = await increment.onTextChangeI()
    if (shouldStart) {
      if (!increment.activted) return
      let {input, option} = increment
      let opt = Object.assign({}, option, {
        input: input.input
      })
      let oldComplete = completes.complete || ({} as {[index:string]:any})
      let {results} = oldComplete
      if (!results || results.length == 0) {
        await increment.stop()
        return
      }
      let start = Date.now()
      logger.debug(`Resume options: ${JSON.stringify(opt)}`)
      let {startcol, icase} = oldComplete
      let complete = completes.newComplete(opt)
      let items = complete.filterResults(results, icase)
      logger.debug(`Filtered items:${JSON.stringify(items)}`)
      if (!items || items.length === 0) {
        await increment.stop()
        return
      }
      let completeOpt = getConfig('completeOpt')
      // menu in completeopt, reset compelteopt, make vim insert
      if (items.length == 1 && /menu(?!one)/.test(completeOpt)) {
        await increment.stop()
      }
      nvim.setVar('coc#_context', {
        start: startcol,
        candidates: items
      }).catch(this.handleError)
      nvim.call('coc#_do_complete', []).then(() => {
        logger.debug(`Complete time cost: ${Date.now() - start}ms`)
      }).catch(this.handleError)
    }
  }

  // callback for remote sources
  @Function('CocResult', {sync: false})
  public async cocResult(args: any[]):Promise<void> {
    let id = Number(args[0])
    let name = args[1] as string
    let items = args[2] as VimCompleteItem[]
    items = items || []
    logger.debug(`Remote ${name} result count: ${items.length}`)
    remoteStore.setResult(id, name, items)
  }

  // Used for :checkhealth
  @Function('CocCheck', {sync: true})
  public async cocCheck():Promise<string[] | null> {
    let {nvim} = this
    await remotes.init(nvim, natives.names, true)
    let {names} = remotes
    let success = true
    for (let name of names) {
      let source = remotes.createSource(nvim, name, true)
      if (source == null) {
        success = false
      }
    }
    return success ? names: null
  }

  @Function('CocSourceStat', {sync: true})
  public async cocSourceStat():Promise<SourceStat[]> {
    let disabled = getConfig('disabled')
    let res: SourceStat[] = []
    let items:any = natives.list.concat(remotes.list as any)
    for (let item of items) {
      let {name, filepath} = item
      res.push({
        name,
        type: natives.has(name) ? 'native' : 'remote',
        disabled: disabled.indexOf(name) !== -1,
        filepath
      })
    }
    return res
  }

  @Function('CocSourceToggle', {sync: true})
  public async cocSourceToggle(args: any):Promise<string> {
    let name = args[0].toString()
    if (!name) return ''
    if (!natives.has(name) && !remotes.has(name)) {
      await echoErr(this.nvim, `Source ${name} not found`)
      return ''
    }
    return toggleSource(name)
  }

  @Function('CocSourceRefresh', {sync: true})
  public async cocSourceRefresh(args: any):Promise<boolean> {
    let name = args[0].toString()
    if (name) {
      let m = natives.has(name) ? natives : remotes
      let source = await m.getSource(this.nvim, name)
      if (!source) {
        await echoErr(this.nvim, `Source ${name} not found`)
        return false
      }
      await source.refresh()
    } else {
      for (let m of [remotes, natives]) {
        for (let s of m.sources) {
          if (s) {
            await s.refresh()
          }
        }
      }
    }
    return true
  }

  private async onBufferChange(bufnr: string):Promise<void> {
    let listed = await this.nvim.call('getbufvar', [Number(bufnr), '&buflisted'])
    if (listed) await buffers.addBuffer(this.nvim, bufnr)
  }

  private async initConfig(): Promise<void> {
    let {nvim} = this
    let opts: {[index: string]: any} = await nvim.call('coc#get_config', [])
    setConfig(opts)
  }
}
