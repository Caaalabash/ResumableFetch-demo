## 关于HTTP Range范围请求

在看[云音乐大前端专栏 - 从 Fetch 到 Streams —— 以流的角度处理网络请求](https://musicfe.dev/streams-api/)
文章时，了解到了很多新知识。于是，本篇从`range`请求头入手，梳理一下相关技术点，包括如下内容：

+ 基础部分：涉及到`range`相关的消息头、状态码
+ 后端部分：如何支持范围请求，分析`koa-range`
+ 前端部分：`fetch api` + `stream api` + 有限状态机实现一个`ResumableFetch`，实现断点下载以及实时下载进度

## 1. 前置知识

### 1.1 Accept-Ranges响应头：告知客户端自身支持范围请求

语法：

````
// 范围请求的单位是 bytes （字节）。
Accept-Ranges: bytes
// 不支持任何范围请求单位，由于其等同于没有返回此头部，因此很少使用。不过一些浏览器，比如IE9，会依据该头部去禁用或者移除下载管理器的暂停按钮。
Accept-Ranges: none
````

### 1.2 Range请求头：告知服务器返回文件的哪一部分

语法，其中`<unit>`通常是字节bytes，`<range-start>`和`<range-end>`都是闭区间

````
Range: <unit>=<range-start>-
Range: <unit>=<range-start>-<range-end>
Range: <unit>=<range-start>-<range-end>, <range-start>-<range-end>
Range: <unit>=<range-start>-<range-end>, <range-start>-<range-end>, <range-start>-<range-end>
````

这里可以看下[阿里云 - 如何通过HTTP Range请求分段获取OSS资源](https://help.aliyun.com/document_detail/39571.html) ，看看OSS一般是怎么处理的

### 1.3 Content-Range响应头：告知客户端返回文件的哪一部分

语法，常见的是第一种，不清楚内容长度`<size>`时，使用`*`

````
Content-Range: <unit> <range-start>-<range-end>/<size>
Content-Range: <unit> <range-start>-<range-end>/*
Content-Range: <unit> */<size>
````

### 1.4 If-Range请求头：使得Range请求头在一定条件下生效

> 当字段值中的条件得到满足时，Range 头字段才会起作用，同时服务器回复 206 部分内容状态码，以及 Range 头字段请求的相应部分；
> 如果字段值中的条件没有得到满足，服务器将会返回 200 OK 状态码，并返回完整的请求资源。
> 字段值中既可以用 Last-Modified 时间值用作验证，也可以用 ETag 标记作为验证，但不能将两者同时使用。
> If-Range 头字段通常用于断点续传的下载过程中，用来自从上次中断后，确保下载的资源没有发生改变。

语法，例如：`If-Range: Wed, 21 Oct 2015 07:28:00 GMT`

````
If-Range: <day-name>, <day> <month> <year> <hour>:<minute>:<second> GMT
If-Range: <etag>
````

### 1.5 206 Partial Content状态码：请求已成功，并且主体包含所请求的数据区间

值得一提的是：

如果是单个数据区间，响应的`Content-Type`的值为所请求的文件的类型

````
Content-Range: bytes 21010-47021/47022
Content-Length: 26012
Content-Type: image/gif
````

如果是多个数据区间，响应的`Content-Type`值为`multipart/byteranges`

````
Content-Type: multipart/byteranges; boundary=String_separator

--String_separator
Content-Type: application/pdf
Content-Range: bytes 234-639/8000

...the first range...
--String_separator
Content-Type: application/pdf
Content-Range: bytes 4590-7999/8000

...the second range
--String_separator--
````

### 1.6 416 Range Not Satisfiable状态码：无法处理所请求的数据区间

416响应报文包含一个 `Content-Range` 首部，提示无法满足的数据区间（用星号 * 表示），后面紧跟着一个“/”，再后面是当前资源的长度。

例如：`Content-Range: */12777`


## 2. 后端如何支持范围请求

一开始想的是按照 [rfc7233#section-4.1](https://tools.ietf.org/html/rfc7233#section-4.1) ，你规范怎么写我怎么实现，但还是too young。

随便测试了几个网站，发现都不支持请求多个数据区间，所以，按需实现即可。

下面的代码基本是对 [koa-range](https://www.npmjs.com/package/koa-range) 的分析

demo:

````javascript
const fs = require('fs')
const range = require('koa-range')
const route = require('koa-route')
const Koa = require('koa')
const app = new Koa()
 
app.use(range)
 
// via buffer
app.use(route.get('/', async function (ctx) {
  ctx.body = new Buffer(100)
}))
````

### 2.1 range-parser和range-formatter

````javascript
function rangeFormatter(start, end, size) {
  return `bytes ${start}-${end}/${size}`
}

// 支持多区间的rangeParse
function rangeParse(str) {
  const token = str.split('=')
  if (!token || token.length !== 2 || token[0] !== 'bytes') {
    return null
  }
  return token[1].split(',')
    .map(range => {
      return range.split('-').map(val => {
        if (val === '') {
          return Infinity
        }
        return Number(val)
      })
    })
    .filter(range => {
      return !isNaN(range[0]) && !isNaN(range[1]) && range[0] <= range[1]
    })
}
````

### 2.2 中间件实现

````javascript
module.exports = async function (ctx, next) {
  const range = ctx.header.range
  ctx.set('Accept-Ranges', 'bytes')

  if (!range) {
    return next()
  }
  const ranges = rangeParse(range)

  if (!ranges || ranges.length == 0) {
    ctx.status = 416
    return
  }
  if (ctx.method == 'PUT') {
    ctx.status = 400
    return
  }

  await next()

  if (ctx.method != 'GET' || ctx.body == null) {
    return
  }

  const first = ranges[0]
  let rawBody = ctx.body
  let len = rawBody.length

  // 只处理第一段
  const firstRange = ranges[0]
  const start = firstRange[0]
  const end = firstRange[1]
  // 需要区分stream/string/object
  if (!Buffer.isBuffer(rawBody)) {
    if (rawBody instanceof Stream.Readable) {
      len = ctx.length || '*';
      rawBody = rawBody.pipe(slice(start, end + 1));
    } else if (typeof rawBody !== 'string') {
      rawBody = new Buffer(JSON.stringify(rawBody));
      len = rawBody.length;
    } else {
      rawBody = new Buffer(rawBody);
      len = rawBody.length;
    }
  }

  // 处理 Infinity
  if (end === Infinity) {
    if (Number.isInteger(len)) {
      end = len - 1
    } else {
      // 如果响应是个流，且range: bytes=1-，返回200就可以了
      ctx.status = 200
      return
    }
  }
  // end+1是因为 buffer slice是左闭右开的
  const args = [start, end+1].filter(function(item) {
    return typeof item == 'number'
  })

  ctx.set('Content-Range', rangeFormatter(start, end, len))
  ctx.status = 206

  if (rawBody instanceof Stream) {
    ctx.body = rawBody
  } else {
    ctx.body = rawBody.slice.apply(rawBody, args)
  }
  
  if (len !== '*') {
    ctx.length = end - start + 1
  }
}
````

## 3. 前端的断点下载

此处实现一个`ResumableFetch`：

+ 通过`fetch` + `AbortController`实现暂停
+ 通过记录要下载的总长度、已下载的总长度、`range`请求头，实现恢复
+ 实现进度条功能

demo

````javascript
// 同fetch的参数
const request = new ResumableFetch(input, init)

// 开始/继续下载，这里的 res 同 fetch().then(res) 的res
request.start().then(res)

// 暂停下载
request.abort()

// 重置状态
request.reset()

// 进度条
request.onprogress = ({ total, loaded }) => {
  // 例如设置一个<progress>的value
  progressEle.value = loaded / total
}
````

### 3.1 有限状态机来描述`ResumableFetch`的状态

用有限状态机描述`ResumableFetch`之间的状态变化：

状态 state 可以表示为：

+ 初始状态`init`: 还没开始下载
+ 下载状态`fetching`: 下载中
+ 暂停状态`waiting`: 暂停
+ 结束状态`end`: 下载完成

转移关系 transition 表现为：

+ `fetch`操作：init -> fetching
+ `abort`操作：fetching -> waiting
+ `resume`操作：waiting -> fetching
+ `finish`操作：fetching -> end
+ `reset`操作：fetching/waiting/end -> init

### 3.2 代码实现

````javascript
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
````

效果如下：

<video src="https://static.calabash.top/QQ20210510-101900-HD.mp4" controls width="100%"></video>
