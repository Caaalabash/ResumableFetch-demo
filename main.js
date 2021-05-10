import './style.css'
import StateMachine from 'javascript-state-machine'

// 可暂停->恢复的fetch
class ResumableFetch {
  constructor(input, init) {
    // input/init同fetch api
    this.input = input
    this.init = init || {}
    // 状态机描述
    this.stateMache = new StateMachine({
      init: 'init',
      transitions: [
        { name: 'fetch', from: 'init', to: 'fetching' },
        { name: 'abort', from: 'fetching', to: 'waiting' },
        { name: 'resume', from: 'waiting', to: 'fetching' },
        { name: 'finish', from: 'fetching', to: 'end' },
        { name: 'reset', from: ['fetching', 'waiting', 'end'], to: 'init' },
      ],
      methods: {
        onFetch: () => this.onFetch(true),
        onAbort: () => this.onAbort(),
        onResume: () => this.onFetch(false),
        onReset: () => this.onReset(),
      }
    })
    this._request = null
    this._contentType = null
    this._contentLength = 0
    this._downloadLength = 0
    this._aborter = null
    this._chunks = []
  }
  // 对外提供 reset 重置 / start 开始 / abort 暂停 三个操作
  // 都通过状态机中的transitions定义判断"能不能从A状态切换到B状态"
  reset() {
    if (this.stateMache.can('reset')) {
      this.stateMache.reset()
    } else {
      console.warn(`[ResumableFetch] You can't perform reset on "${this.stateMache.state}" state`)
    }
  }
  start() {
    if (this.stateMache.can('fetch')) {
      this.stateMache.fetch()
      return this._request
    } else if (this.stateMache.can('resume')) {
      this.stateMache.resume()
      return this._request
    } else {
      console.warn(`[ResumableFetch] You can't perform fetch/resume on "${this.stateMache.state}" state`)
    }
  }
  abort() {
    if (this.stateMache.can('abort')) {
      this.stateMache.abort()
    } else {
      console.warn(`[ResumableFetch] You can't perform abort on "${this.stateMache.state}" state`)
    }
  }
  // 调用abort(), 状态从fetching -> waiting，然后触发onAbort()
  // 中断请求，重置_aborter
  onAbort() {
    this._aborter.abort()
    this._aborter = null
  }
  // 调用reset(), 状态从 fetching/waiting/end -> init，然后触发onReset
  // 如果在请求中，中断请求，重置相关数据
  onReset() {
    this._request = null
    this._contentType = null
    this._contentLength = 0
    this._downloadLength = 0
    if (this._aborter) {
      this._aborter.abort()
    }
    this._aborter = null
    this._chunks = []
  }
  // 调用start(), init -> fetching，触发onFetch(true)，waiting -> fetching，触发onFetch(false)
  onFetch(isFetch) {
    this._aborter = new AbortController()
    const { headers } = this.init
    // 添加中断控制器信号以及range请求头，每次都从上次记录位置继续请求余下的内容
    const init = {
      ...this.init,
      headers: {
        ...headers,
        ...(isFetch ? {} : { Range: `bytes=${this._downloadLength}-` })
      },
      signal: this._aborter.signal
    }
    this._request = fetch(this.input, init)
      .then(res => {
        // 首次请求记录 下载文件类型/下载文件总长度
        if (isFetch) {
          this._contentLength = res.headers.get('content-length')
          this._contentType = res.headers.get('content-type')
        }
        return res.body.getReader()
      })
      // 涉及到stream api
      .then(reader => this.readChunks(reader))
      // 这一步很大程度上只是为了让 new ResumableFetch().start() 等价于 fetch()
      .then(chunks => {
        const stream = new ReadableStream({
          start(controller) {
            const push = () => {
              const chunk = chunks.shift()
              if (!chunk) {
                controller.close()
                return
              }
              controller.enqueue(chunk)
              push()
            }
            push()
          }
        })
        return new Response(stream, {
          headers: {
            'content-type': this._contentType,
            'content-length': this._contentLength
          }
        })
      })
  }
  readChunks(reader) {
    // 不断从可读流中取得数据，更新已下载长度，以及进度条
    return reader.read().then(({ value, done }) => {
      if (done) {
        this.stateMache.finish()
        return this._chunks
      }
      this._chunks.push(value)
      this._downloadLength += value.length
      if (this.onprogress) {
        this.onprogress({
          total: this._contentLength,
          loaded: this._downloadLength
        })
      }
      return this.readChunks(reader)
    })
  }
}

window.onload = () => {
  // localhost:3000 允许跨域 + 允许range请求头
  const url = 'https://static.calabash.top/QQ20210508-175653-HD.mp4'
  const progressEle = document.getElementById('progress')
  const actionEle = document.getElementById('action')
  const resetEle = document.getElementById('reset')
  const statusEle = document.getElementById('status')
  const img = document.getElementById('img')
  let isDownloading = false

  const request = new ResumableFetch(url)

  request.onprogress = ({ total, loaded }) => {
    progressEle.value = loaded / total;
    statusEle.textContent = `Downloading (${loaded}/${total})`;
  }

  resetEle.addEventListener('click', () => {
    request.reset()
    progressEle.value = 0
    statusEle.textContent = ''
    isDownloading = false
    actionEle.textContent = 'Download'
    img.style.display = 'none'
  })

  actionEle.addEventListener('click', () => {
    if (isDownloading) {
      isDownloading = false
      request.abort()
      actionEle.textContent = 'Resume'
      statusEle.textContent = 'Paused'
    } else {
      isDownloading = true
      request.start().then(res => res.blob())
        .then((blob) => {
          const url = URL.createObjectURL(blob)
          img.src = url
          img.style.display = 'block'
        });
      actionEle.textContent = 'Pause'
      statusEle.textContent = 'Downloading'
    }
  })
}


document.querySelector('#app').innerHTML = `
  <div>
    <progress id="progress" max="1" value="0"></progress>
    <button id="action">Download</button>
    <button id="reset">Reset</button>
    <span id="status"></span>
    <video width="640" height="360" alt="Photo of Gray Cat Looking Up Against Black Background by Snapwire (CC0)" id="img" style="display: none" controls>
  </div>
`
