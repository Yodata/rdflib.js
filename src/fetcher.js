/* global $SolidTestEnvironment */
/**
 *
 * Project: rdflib.js
 *
 * File: fetcher.js
 *
 * Description: contains functions for requesting/fetching/retracting
 *  This implements quite a lot of the web architecture.
 * A fetcher is bound to a specific knowledge base graph, into which
 * it loads stuff and into which it writes its metadata
 * @@ The metadata should be optionally a separate graph
 *
 * - implements semantics of HTTP headers, Internet Content Types
 * - selects parsers for rdf/xml, n3, rdfa, grddl
 */

/**
 * Things to test: callbacks on request, refresh, retract
 *   loading from HTTP, HTTPS, FTP, FILE, others?
 * To do:
 * Firing up a mail client for mid:  (message:) URLs
 */
const log = require('./log')
const N3Parser = require('./n3parser')
const NamedNode = require('./named-node')
const Namespace = require('./namespace')
const rdfParse = require('./parse')
const parseRDFaDOM = require('./rdfaparser').parseRDFaDOM
const RDFParser = require('./rdfxmlparser')
const Uri = require('./uri')
const Util = require('./util')
const serialize = require('./serialize')

const Parsable = {
  'text/n3': true,
  'text/turtle': true,
  'application/rdf+xml': true,
  'application/xhtml+xml': true,
  'text/html': true,
  'application/ld+json': true
}

// Convenience namespaces needed in this module.
// These are deliberately not exported as the user application should
// make its own list and not rely on the prefixes used here,
// and not be tempted to add to them, and them clash with those of another
// application.
const ns = {
  link: Namespace('http://www.w3.org/2007/ont/link#'),
  http: Namespace('http://www.w3.org/2007/ont/http#'),
  httph: Namespace('http://www.w3.org/2007/ont/httph#'),  // headers
  rdf: Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#'),
  rdfs: Namespace('http://www.w3.org/2000/01/rdf-schema#'),
  dc: Namespace('http://purl.org/dc/elements/1.1/')
}

class Handler {
  constructor (args) {
    this.dom = args ? args[0] : undefined
  }
}

class RDFXMLHandler extends Handler {
  static toString () {
    return 'RDFXMLHandler'
  }

  static register (fetcher) {
    fetcher.mediatypes['application/rdf+xml'] = {
      'q': 0.9
    }
  }

  handlerFactory (xhr, fetcher) {
    xhr.handle = (cb) => {
      // sf.addStatus(xhr.req, 'parsing soon as RDF/XML...')
      let kb = fetcher.store
      if (!this.dom) {
        this.dom = Util.parseXML(xhr.responseText)
      }
      let root = this.dom.documentElement
      if (root.nodeName === 'parsererror') { // Mozilla only See issue/issue110
        // have to fail the request
        fetcher.failFetch(xhr, 'Badly formed XML in ' + xhr.resource.uri)
        // Add details
        throw new Error('Badly formed XML in ' + xhr.resource.uri)
      }
      let parser = new RDFParser(kb)
      try {
        parser.parse(this.dom, xhr.original.uri, xhr.original)
      } catch (e) {
        fetcher.addStatus(xhr.req, 'Syntax error parsing RDF/XML! ' + e)
        console.log('Syntax error parsing RDF/XML! ' + e)
      }
      if (!xhr.options.noMeta) {
        kb.add(xhr.original, ns.rdf('type'), ns.link('RDFDocument'), fetcher.appNode)
      }
      cb()
    }
  }

  // This would much better use on-board XSLT engine. @@
  /*  deprecated 2016-02-17  timbl
   Fetcher.doGRDDL = function(kb, doc, xslturi, xmluri) {
   sf.requestURI('http://www.w3.org/2005/08/' + 'online_xslt/xslt?' +
     'xslfile=' + escape(xslturi) + '&xmlfile=' + escape(xmluri), doc)
   }
   */
}
RDFXMLHandler.pattern = new RegExp('application/rdf\\+xml')

class XHTMLHandler extends Handler {
  static toString () {
    return 'XHTMLHandler'
  }

  static register (fetcher) {
    fetcher.mediatypes['application/xhtml+xml'] = {}
  }

  handlerFactory (xhr, fetcher) {
    xhr.handle = (cb) => {
      let relation, reverse
      if (!this.dom) {
        this.dom = Util.parseXML(xhr.responseText)
      }
      let kb = fetcher.store

      // dc:title
      let title = this.dom.getElementsByTagName('title')
      if (title.length > 0) {
        kb.add(xhr.resource, ns.dc('title'), kb.literal(title[0].textContent), xhr.resource)
        // log.info("Inferring title of " + xhr.resource)
      }

      // link rel
      let links = this.dom.getElementsByTagName('link')
      for (let x = links.length - 1; x >= 0; x--) { // @@ rev
        relation = links[x].getAttribute('rel')
        reverse = false
        if (!relation) {
          relation = links[x].getAttribute('rev')
          reverse = true
        }
        if (relation) {
          fetcher.linkData(xhr, relation,
            links[x].getAttribute('href'), xhr.resource, reverse)
        }
      }

      // Data Islands

      let scripts = this.dom.getElementsByTagName('script')
      for (let i = 0; i < scripts.length; i++) {
        let contentType = scripts[i].getAttribute('type')
        if (Parsable[contentType]) {
          rdfParse(scripts[i].textContent, kb, xhr.original.uri, contentType)
        }
      }

      if (!xhr.options.noMeta) {
        kb.add(xhr.resource, ns.rdf('type'), ns.link('WebPage'), fetcher.appNode)
      }

      if (!xhr.options.noRDFa && parseRDFaDOM) { // enable by default
        try {
          parseRDFaDOM(this.dom, kb, xhr.original.uri)
        } catch (e) {
          let msg = ('Error trying to parse ' + xhr.resource + ' as RDFa:\n' +
            e + ':\n' + e.stack)
          // dump(msg+"\n")
          fetcher.failFetch(xhr, msg)
          return
        }
      }
      cb() // Fire done callbacks
    }
  }
}
XHTMLHandler.pattern = new RegExp('application/xhtml')

class XMLHandler extends Handler {
  static toString () {
    return 'XMLHandler'
  }

  static register (fetcher) {
    fetcher.mediatypes['text/xml'] = { 'q': 0.5 }
    fetcher.mediatypes['application/xml'] = { 'q': 0.5 }
  }

  handlerFactory (xhr, fetcher) {
    xhr.handle = (cb) => {
      let dom = Util.parseXML(xhr.responseText)

      // XML Semantics defined by root element namespace
      // figure out the root element
      for (let c = 0; c < dom.childNodes.length; c++) {
        // is this node an element?
        if (dom.childNodes[c].nodeType === 1) {
          // We've found the first element, it's the root
          let ns = dom.childNodes[c].namespaceURI

          // Is it RDF/XML?
          if (ns && ns === ns['rdf']) {
            fetcher.addStatus(xhr.req, 'Has XML root element in the RDF namespace, so assume RDF/XML.')
            fetcher.switchHandler('RDFXMLHandler', xhr, cb, [dom])
            return
          }
          // it isn't RDF/XML or we can't tell
          // Are there any GRDDL transforms for this namespace?
          // @@ assumes ns documents have already been loaded
          /*
           var xforms = kb.each(kb.sym(ns), kb.sym("http://www.w3.org/2003/g/data-view#namespaceTransformation"))
           for (var i = 0; i < xforms.length; i++) {
           var xform = xforms[i]
           // log.info(xhr.resource.uri + " namespace " + ns + " has GRDDL ns transform" + xform.uri)
           Fetcher.doGRDDL(kb, xhr.resource, xform.uri, xhr.resource.uri)
           }
           */
          break
        }
      }

      // Or it could be XHTML?
      // Maybe it has an XHTML DOCTYPE?
      if (dom.doctype) {
        // log.info("We found a DOCTYPE in " + xhr.resource)
        if (dom.doctype.name === 'html' &&
            dom.doctype.publicId.match(/^-\/\/W3C\/\/DTD XHTML/) &&
            dom.doctype.systemId.match(/http:\/\/www.w3.org\/TR\/xhtml/)) {
          fetcher.addStatus(xhr.req,
            'Has XHTML DOCTYPE. Switching to XHTML Handler.\n')
          fetcher.switchHandler('XHTMLHandler', xhr, cb)
          return
        }
      }

      // Or what about an XHTML namespace?
      let html = dom.getElementsByTagName('html')[0]
      if (html) {
        let xmlns = html.getAttribute('xmlns')
        if (xmlns && xmlns.match(/^http:\/\/www.w3.org\/1999\/xhtml/)) {
          fetcher.addStatus(xhr.req,
            'Has a default namespace for ' +
            'XHTML. Switching to XHTMLHandler.\n')
          fetcher.switchHandler('XHTMLHandler', xhr, cb)
          return
        }
      }

      // At this point we should check the namespace document (cache it!) and
      // look for a GRDDL transform
      // @@  Get namespace document <n>, parse it, look for  <n> grddl:namespaceTransform ?y
      // Apply ?y to   dom
      // We give up. What dialect is this?
      fetcher.failFetch(xhr,
        'Unsupported dialect of XML: not RDF or XHTML namespace, etc.\n' +
        xhr.responseText.slice(0, 80))
    }
  }
}
XMLHandler.pattern = new RegExp('(text|application)/(.*)xml')

class HTMLHandler extends Handler {
  static toString () {
    return 'HTMLHandler'
  }

  static register (fetcher) {
    fetcher.mediatypes['text/html'] = {
      'q': 0.9
    }
  }

  handlerFactory (xhr, fetcher) {
    xhr.handle = (cb) => {
      let rt = xhr.responseText
      // We only handle XHTML so we have to figure out if this is XML
      // log.info("Sniffing HTML " + xhr.resource + " for XHTML.")

      if (rt.match(/\s*<\?xml\s+version\s*=[^<>]+\?>/)) {
        fetcher.addStatus(xhr.req, "Has an XML declaration. We'll assume " +
          "it's XHTML as the content-type was text/html.\n")
        fetcher.switchHandler('XHTMLHandler', xhr, cb)
        return
      }

      // DOCTYPE
      // There is probably a smarter way to do this
      if (rt.match(/.*<!DOCTYPE\s+html[^<]+-\/\/W3C\/\/DTD XHTML[^<]+http:\/\/www.w3.org\/TR\/xhtml[^<]+>/)) {
        fetcher.addStatus(xhr.req,
          'Has XHTML DOCTYPE. Switching to XHTMLHandler.\n')
        fetcher.switchHandler('XHTMLHandler', xhr, cb)
        return
      }

      // xmlns
      if (rt.match(/[^(<html)]*<html\s+[^<]*xmlns=['"]http:\/\/www.w3.org\/1999\/xhtml["'][^<]*>/)) {
        fetcher.addStatus(xhr.req,
          'Has default namespace for XHTML, so switching to XHTMLHandler.\n')
        fetcher.switchHandler('XHTMLHandler', xhr, cb)
        return
      }

      // dc:title
      // no need to escape '/' here
      let titleMatch = (new RegExp('<title>([\\s\\S]+?)</title>', 'im')).exec(rt)
      if (titleMatch) {
        let kb = fetcher.store
        kb.add(
          xhr.resource,
          ns.dc('title'),
          kb.literal(titleMatch[1]),
          xhr.resource
        ) // think about xml:lang later
        kb.add(xhr.resource, ns.rdf('type'), ns.link('WebPage'), fetcher.appNode)
        cb() // doneFetch, not failed
        return
      }
      fetcher.addStatus(xhr.req, 'non-XML HTML document, not parsed for data.')
      fetcher.doneFetch(xhr)
      // sf.failFetch(xhr, "Sorry, can't yet parse non-XML HTML")
    }
  }
}
HTMLHandler.pattern = new RegExp('text/html')

class TextHandler extends Handler {
  static toString () {
    return 'TextHandler'
  }

  static register (fetcher) {
    fetcher.mediatypes['text/plain'] = {
      'q': 0.5
    }
  }

  handlerFactory (xhr, fetcher) {
    xhr.handle = (cb) => {
      // We only speak dialects of XML right now. Is this XML?
      let rt = xhr.responseText

      // Look for an XML declaration
      if (rt.match(/\s*<\?xml\s+version\s*=[^<>]+\?>/)) {
        fetcher.addStatus(xhr.req, 'Warning: ' + xhr.resource +
          " has an XML declaration. We'll assume " +
          "it's XML but its content-type wasn't XML.\n")
        fetcher.switchHandler('XMLHandler', xhr, cb)
        return
      }

      // Look for an XML declaration
      if (rt.slice(0, 500).match(/xmlns:/)) {
        fetcher.addStatus(xhr.req, "May have an XML namespace. We'll assume " +
          "it's XML but its content-type wasn't XML.\n")
        fetcher.switchHandler('XMLHandler', xhr, cb)
        return
      }

      // We give up finding semantics - this is not an error, just no data
      fetcher.addStatus(xhr.req, 'Plain text document, no known RDF semantics.')
      fetcher.doneFetch(xhr)
      // fetcher.failFetch(xhr, "unparseable - text/plain not visibly XML")
      // dump(xhr.resource + " unparseable - text/plain not visibly XML,
      //   starts:\n" + rt.slice(0, 500)+"\n")
    }
  }
}
TextHandler.pattern = new RegExp('text/plain')

class N3Handler extends Handler {
  static toString () {
    return 'N3Handler'
  }

  static register (fetcher) {
    fetcher.mediatypes['text/n3'] = {
      'q': '1.0'
    } // as per 2008 spec
    /*
     fetcher.mediatypes['application/x-turtle'] = {
     'q': 1.0
     } // pre 2008
     */
    fetcher.mediatypes['text/turtle'] = {
      'q': 1.0
    } // post 2008
  }

  handlerFactory (xhr, fetcher) {
    const kb = fetcher.store

    xhr.handle = () => {
      // Parse the text of this non-XML file

      // console.log('web.js: Parsing as N3 ' + xhr.resource.uri + ' base: ' +
      // xhr.original.uri) // @@@@ comment me out
      // fetcher.addStatus(xhr.req, "N3 not parsed yet...")
      let p = N3Parser(kb, kb, xhr.original.uri, xhr.original.uri,
        null, null, '', null)
      //                p.loadBuf(xhr.responseText)
      try {
        p.loadBuf(xhr.responseText)
      } catch (e) {
        let msg = 'Error trying to parse ' + xhr.resource +
          ' as Notation3:\n' + e + ':\n' + e.stack
        // dump(msg+"\n")
        fetcher.failFetch(xhr, msg)
        return
      }

      fetcher.addStatus(xhr.req, 'N3 parsed: ' + p.statementCount + ' triples in ' + p.lines + ' lines.')
      fetcher.store.add(xhr.original, ns.rdf('type'), ns.link('RDFDocument'), fetcher.appNode)
      // var args = [xhr.original.uri] // Other args needed ever?
      fetcher.doneFetch(xhr)
    }
  }
}
N3Handler.pattern = new RegExp('(application|text)/(x-)?(rdf\\+)?(n3|turtle)')

const HANDLERS = {
  RDFXMLHandler, XHTMLHandler, XMLHandler, HTMLHandler, TextHandler, N3Handler
}

class Fetcher {
  constructor (store, timeout, async) {
    this.store = store
    this.timeout = timeout || 30000
    this.async = async != null ? async : true
    this.appNode = this.store.bnode() // Denoting this session
    this.store.fetcher = this // Bi-linked
    this.requested = {}
    // this.requested[uri] states:
    //   undefined     no record of web access or records reset
    //   true          has been requested, XHR in progress
    //   'done'        received, Ok
    //   403           HTTP status unauthorized
    //   404           Resource does not exist. Can be created etc.
    //   'redirected'  In attempt to counter CORS problems retried.
    //   other strings mean various other errors, such as parse errors.
    //
    this.redirectedTo = {} // When 'redirected'
    this.fetchCallbacks = {} // fetchCallbacks[uri].push(callback)

    this.nonexistant = {} // keep track of explicit 404s -> we can overwrite etc
    this.lookedUp = {}
    this.handlers = []
    this.mediatypes = {
      'image/*': { 'q': 0.9 },
      '*/*': { 'q': 0.1 }  // Must allow access to random content
    }

    Util.callbackify(this, ['request', 'recv', 'headers', 'load', 'fail',
      'refresh', 'retract', 'done'])

    Object.keys(HANDLERS).map(key => this.addHandler(HANDLERS[key]))
  }

  static crossSiteProxy (uri) {
    if (Fetcher.crossSiteProxyTemplate) {
      return Fetcher.crossSiteProxyTemplate
        .replace('{uri}', encodeURIComponent(uri))
    } else {
      return undefined
    }
  }

  /**
   * Promise-based load function
   *
   * NamedNode -> Promise of xhr
   * uri string -> Promise of xhr
   * Array of the above -> Promise of array of xhr
   *
   * @@ todo: If p1 is array then sequence or parallel fetch of all
   *
   * @param uri {Node|string}
   * @param options
   *
   * @returns {Promise}
   */
  load (uri, options) {
    if (uri instanceof Array) {
      return Promise.all(
        uri.map(x => { return this.load(x) })
      )
    }

    uri = uri.uri || uri // NamedNode or URI string

    return new Promise((resolve, reject) => {
      this.nowOrWhenFetched(uri, options, (ok, message, xhr) => {
        if (ok) {
          resolve(xhr)
        } else {
          reject(message)
        }
      })
    })
  }

  /**
   * Asks for a doc to be loaded if necessary then calls back
   *
   * Calling methods:
   *   nowOrWhenFetched (uri, userCallback)
   *   nowOrWhenFetched (uri, options, userCallback)
   *   nowOrWhenFetched (uri, referringTerm, userCallback, options)  <-- old
   *   nowOrWhenFetched (uri, referringTerm, userCallback) <-- old
   *
   *  Options include:
   *   referingTerm    The document in which this link was found.
   *                    this is valuable when finding the source of bad URIs
   *   force            boolean.  Never mind whether you have tried before,
   *                    load this from scratch.
   *   forceContentType Override the incoming header to force the data to be
   *                    treated as this content-type.
   */
  nowOrWhenFetched (uri, p2, userCallback, options = {}) {
    uri = uri.uri || uri // allow symbol object or string to be passed
    if (typeof p2 === 'function') {
      userCallback = p2
    } else if (typeof p2 === 'undefined') { // original calling signature
      // referingTerm = undefined
    } else if (p2 instanceof NamedNode) {
      // referingTerm = p2
      options = { referingTerm: p2 }
    } else {
      options = p2
    }

    this.requestURI(uri, p2, options, userCallback)
  }

  get (uri, p2, userCallback, options) {
    this.nowOrWhenFetched(uri, p2, userCallback, options)
  }

  /**
   * Records a status message (as a literal node) by appending it to the
   * request's metadata status collection.
   *
   * @param req {BlankNode}
   * @param status {string}
   */
  addStatus (req, status) {
    // <Debug about="parsePerformance">
    let now = new Date()
    status = '[' + now.getHours() + ':' + now.getMinutes() + ':' +
      now.getSeconds() + '.' + now.getMilliseconds() + '] ' + status
    // </Debug>
    let kb = this.store

    let statusNode = kb.the(req, ns.link('status'))
    if (statusNode && statusNode.append) {
      statusNode.append(kb.literal(status))
    } else {
      log.warn('web.js: No list to add to: ' + statusNode + ',' + status)
    }
  }

  /**
   * Records errors in the system on failure:
   *
   *  - Adds an entry to the request status collection
   *  - Adds an error triple with the fail message to the metadata
   *  - Signals failure by calling all the `fetchCallbacks` with a fail message
   *  - Fires the 'fail' callback
   *  - Calls xhr.abort()
   *
   * Returns xhr so can just do return this.failFetch(...)
   */
  failFetch (xhr, status) {
    this.addStatus(xhr.req, status)

    if (!xhr.options.noMeta) {
      this.store.add(xhr.original, ns.link('error'), status)
    }

    if (!xhr.resource.sameTerm(xhr.original)) {
      console.log('@@ Recording failure original ' + xhr.original + '( as ' + xhr.resource + ') : ' + xhr.status)
    } else {
      console.log('@@ Recording failure for ' + xhr.original + ': ' + xhr.status)
    }

    // changed 2015 was false
    this.requested[Uri.docpart(xhr.original.uri)] = xhr.status

    while (this.fetchCallbacks[xhr.original.uri] &&
           this.fetchCallbacks[xhr.original.uri].length) {
      this.fetchCallbacks[xhr.original.uri].shift()(
        false, 'Fetch of <' + xhr.original.uri + '> failed: ' + status, xhr
      )
    }
    delete this.fetchCallbacks[xhr.original.uri]
    this.fireCallbacks('fail', [xhr.original.uri, status])
    xhr.abort()
    return xhr
  }

  // in the why part of the quad distinguish between HTML and HTTP header
  // Reverse is set iif the link was rev= as opposed to rel=
  linkData (xhr, rel, uri, why, reverse) {
    if (!uri) return
    let kb = this.store
    let predicate
    // See http://www.w3.org/TR/powder-dr/#httplink for describedby 2008-12-10
    let obj = kb.sym(Uri.join(uri, xhr.original.uri))

    if (rel === 'alternate' || rel === 'seeAlso' || rel === 'meta' ||
        rel === 'describedby') {
      if (obj.uri === xhr.original.uri) { return }
      predicate = ns.rdfs('seeAlso')
    } else if (rel === 'type') {
      predicate = kb.sym('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
    } else {
      // See https://www.iana.org/assignments/link-relations/link-relations.xml
      // Alas not yet in RDF yet for each predicate
      /// encode space in e.g. rel="shortcut icon"
      predicate = kb.sym(
        Uri.join(encodeURIComponent(rel),
          'http://www.iana.org/assignments/link-relations/')
      )
    }
    if (reverse) {
      kb.add(obj, predicate, xhr.original, why)
    } else {
      kb.add(xhr.original, predicate, obj, why)
    }
  }

  parseLinkHeader (xhr, thisReq) {
    let link

    try {
      link = xhr.getResponseHeader('link') // May crash from CORS error
    } catch (err) {}

    if (!link) { return }

    const linkexp = /<[^>]*>\s*(\s*;\s*[^\(\)<>@,;:"\/\[\]\?={} \t]+=(([^\(\)<>@,;:"\/\[\]\?={} \t]+)|("[^"]*")))*(,|$)/g
    const paramexp = /[^\(\)<>@,;:"\/\[\]\?={} \t]+=(([^\(\)<>@,;:"\/\[\]\?={} \t]+)|("[^"]*"))/g

    const matches = link.match(linkexp)

    for (let i = 0; i < matches.length; i++) {
      let split = matches[i].split('>')
      let href = split[0].substring(1)
      let ps = split[1]
      let s = ps.match(paramexp)
      for (let j = 0; j < s.length; j++) {
        let p = s[j]
        let paramsplit = p.split('=')
        // var name = paramsplit[0]
        let rel = paramsplit[1].replace(/["']/g, '') // '"
        this.linkData(xhr, rel, href, thisReq)
      }
    }
  }

  doneFetch (xhr) {
    this.addStatus(xhr.req, 'Done.')
    this.requested[xhr.original.uri] = 'done' // Kenny

    while (this.fetchCallbacks[xhr.original.uri] &&
           this.fetchCallbacks[xhr.original.uri].length) {
      this.fetchCallbacks[xhr.original.uri].shift()(true, undefined, xhr)
    }

    delete this.fetchCallbacks[xhr.original.uri]
    this.fireCallbacks('done', [xhr.original.uri])
  }

  /**
   * Note two nodes are now smushed
   * If only one was flagged as looked up, then the new node is looked up again,
   * which will make sure all the URIs are dereferenced
   */
  nowKnownAs (was, now) {
    if (this.lookedUp[was.uri]) {
      // Transfer userCallback
      if (!this.lookedUp[now.uri]) {
        this.lookUpThing(now, was)
      }
    } else if (this.lookedUp[now.uri]) {
      if (!this.lookedUp[was.uri]) {
        this.lookUpThing(was, now)
      }
    }
  }

  /**
   * Returns promise of XHR
   * Writes back to the web what we have in the store for this uri
   *
   * @param uri {Node|string}
   * @param [options={}]
   *
   * @returns {Promise}
   */
  putBack (uri, options = {}) {
    uri = uri.uri || uri // Accept object or string
    let doc = new NamedNode(uri).doc() // strip off #
    options.data = serialize(doc, this.store, doc.uri,
      options.contentType || 'text/turtle')
    return this.webOperation('PUT', uri, options)
  }

  /**
   * Returns promise of XHR
   *
   * @param method
   * @param uri
   * @param options
   *
   * @returns {Promise<XmlHttpRequest>}
   */
  webOperation (method, uri, options = {}) {
    uri = uri.uri || uri
    uri = this.proxyIfNecessary(uri)

    return new Promise((resolve, reject) => {
      let xhr = Util.XMLHTTPFactory()
      xhr.options = options
      xhr.original = this.store.sym(uri)

      if (!options.noMeta && typeof tabulator !== 'undefined') {
        this.saveRequestMetadata(xhr, this.store, uri)
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) { // NOte a 404 can be not afailure
          let ok = (!xhr.status || (xhr.status >= 200 && xhr.status < 300))
          if (!options.noMeta && typeof tabulator !== 'undefined') {
            this.saveResponseMetadata(xhr, this.store)
          }
          if (ok) {
            resolve(xhr)
          } else {
            reject(new Error(xhr.status + ' ' + xhr.statusText))
          }
        }
      }
      xhr.open(method, uri, true)
      xhr.setRequestHeader('Content-type', options.contentType || 'text/turtle')
      xhr.send(options.data ? options.data : undefined)
    })
  }

  /**
   * Looks up something.
   * Looks up all the URIs a things has.
   *
   * @param term {Node} canonical term for the thing whose URI is
   *   to be dereferenced
   * @param rterm {Node} the resource which referred to this
   *   (for tracking bad links)
   * @param options {Object} (old: force parameter) or dictionary of options
   * @param options.force {boolean} Load the data even if loaded before
   *
   * @param oneDone {Function} is called as callback(ok, errorbody, xhr)
   *   for each one
   * @param allDone {Function} is called as callback(ok, errorbody)
   *   for all of them
   *
   * @returns {number} Number of URIs fetched
   */
  lookUpThing (term, rterm, options, oneDone, allDone) {
    let uris = this.store.uris(term) // Get all URIs
    let success = true
    let errors = ''
    let outstanding = {}
    let force

    if (options === false || options === true) { // Old signature
      force = options
      options = { force: force }
    } else {
      if (options === undefined) { options = {} }
      // force = !!options.force
    }

    if (uris) {
      for (let i = 0; i < uris.length; i++) {
        let u = uris[i]
        outstanding[u] = true
        this.lookedUp[u] = true

        this.requestURI(Uri.docpart(u), rterm, options, (ok, body, xhr) => {
          if (ok) {
            if (oneDone) { oneDone(true, u) }
          } else {
            if (oneDone) { oneDone(false, body) }
            success = false
            errors += body + '\n'
          }
          delete outstanding[u]
          if (Object.keys(outstanding).length > 0) {
            return
          }
          if (allDone) {
            allDone(success, errors)
          }
        })
      }
    }
    return uris.length
  }

  /**
   * Looks up response header.
   *
   * @param doc
   * @param header
   *
   * @returns {Array|undefined} a list of header values found in a stored HTTP
   *   response, or [] if response was found but no header found,
   *   or undefined if no response is available.
   */
  getHeader (doc, header) {
    const kb = this.store
    const requests = kb.each(undefined, ns.link('requestedURI'), doc.uri)

    for (let r = 0; r < requests.length; r++) {
      let request = requests[r]
      if (request !== undefined) {
        let response = kb.any(request, ns.link('response'))

        if (response !== undefined) {
          let results = kb.each(response, ns.httph(header.toLowerCase()))

          if (results.length) {
            return results.map(v => { return v.value })
          }

          return []
        }
      }
    }
    return undefined
  }

  proxyIfNecessary (uri) {
    if (typeof tabulator !== 'undefined' && tabulator.isExtension) {
      return uri
    } // Extension does not need proxy

    if (typeof $SolidTestEnvironment !== 'undefined' &&
        $SolidTestEnvironment.localSiteMap) {
      // nested dictionaries of URI parts from origin down
      let hostpath = uri.split('/').slice(2) // the bit after the //

      const lookup = (parts, index) => {
        let z = index[parts.shift()]

        if (!z) { return null }

        if (typeof z === 'string') {
          return z + parts.join('/')
        }

        if (!parts) { return null }

        return lookup(parts, z)
      }

      const y = lookup(hostpath, $SolidTestEnvironment.localSiteMap)

      if (y) {
        return y
      }
    }

    // browser does 2014 on as https browser script not trusted
    // If the web app origin is https: then the mixed content rules
    // prevent it loading insecure http: stuff so we need proxy.
    if (Fetcher.crossSiteProxyTemplate &&
        typeof document !== 'undefined' && document.location &&
        ('' + document.location).slice(0, 6) === 'https:' && // origin is secure
        uri.slice(0, 5) === 'http:') { // requested data is not
      return Fetcher.crossSiteProxyTemplate
        .replace('{uri}', encodeURIComponent(uri))
    }

    return uri
  }

  saveRequestMetadata (xhr, kb, docuri) {
    let request = kb.bnode()
    xhr.resource = kb.sym(docuri)

    xhr.req = request
    if (!xhr.options.noMeta) { // Store no triples but do mind the bnode for req
      let now = new Date()
      let timeNow = '[' + now.getHours() + ':' + now.getMinutes() + ':' +
        now.getSeconds() + '] '
      kb.add(request, ns.rdfs('label'), kb.literal(timeNow + ' Request for ' +
        docuri), this.appNode)
      kb.add(request, ns.link('requestedURI'), kb.literal(docuri), this.appNode)
      if (xhr.original && xhr.original.uri !== docuri) {
        kb.add(request, ns.link('orginalURI'), kb.literal(xhr.original.uri),
          this.appNode)
      }
      kb.add(request, ns.link('status'), kb.collection(), this.appNode)
    }
    return request
  }

  saveResponseMetadata (xhr, kb) {
    let response = kb.bnode()

    if (xhr.req) kb.add(xhr.req, ns.link('response'), response)
    kb.add(response, ns.http('status'), kb.literal(xhr.status), response)
    kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response)

    xhr.headers = {}
    if (Uri.protocol(xhr.resource.uri) === 'http' ||
        Uri.protocol(xhr.resource.uri) === 'https') {
      xhr.headers = Util.getHTTPHeaders(xhr)
      for (let h in xhr.headers) { // trim below for Safari - adds a CR!
        let value = xhr.headers[h].trim()
        let h2 = h.toLowerCase()
        kb.add(response, ns.httph(h2), value, response)
        if (h2 === 'content-type') { // Convert to RDF type
          kb.add(xhr.resource, ns.rdf('type'), Util.mediaTypeClass(value), response)
        }
      }
    }
    return response
  }

  objectRefresh (term) {
    let uris = this.store.uris(term) // Get all URIs
    if (typeof uris !== 'undefined') {
      for (let i = 0; i < uris.length; i++) {
        this.refresh(this.store.sym(Uri.docpart(uris[i])))
        // what about rterm?
      }
    }
  }

  refresh (term, userCallback) { // sources_refresh
    this.fireCallbacks('refresh', arguments)
    this.requestURI(term.uri, undefined,
      { force: true, clearPreviousData: true }, userCallback)
  }

  retract (term) { // sources_retract
    this.store.removeMany(undefined, undefined, undefined, term)
    if (term.uri) {
      delete this.requested[Uri.docpart(term.uri)]
    }
    this.fireCallbacks('retract', arguments)
  }

  getState (docuri) {
    if (typeof this.requested[docuri] === 'undefined') {
      return 'unrequested'
    } else if (this.requested[docuri] === true) {
      return 'requested'
    } else if (this.requested[docuri] === 'done') {
      return 'fetched'
    } else if (this.requested[docuri] === 'redirected') {
      return this.getState(this.redirectedTo[docuri])
    } else { // An non-200 HTTP error status
      return 'failed'
    }
  }

  isPending (docuri) { // sources_pending
    // doing anyStatementMatching is wasting time
    // if it's not pending: false -> flailed
    //   'done' -> done 'redirected' -> redirected
    return this.requested[docuri] === true
  }

  /**
   * @deprecated use IndexedFormula.removeDocument(doc)
   */
  unload (term) {
    this.store.removeMany(undefined, undefined, undefined, term)
    delete this.requested[term.uri] // So it can be loaded again
  }

  webCopy (here, there, contentType) {
    here = here.uri || here

    return this.webOperation('GET', here)
      .then((xhr) => {
        return this.webOperation(
          'PUT', // change to binary from text
          there, { data: xhr.responseText, contentType })
      })
  }

  addHandler (handler) {
    this.handlers.push(handler)
    handler.register(this)
  }

  switchHandler (name, xhr, cb, args) {
    let Handler = HANDLERS[name]

    if (!Handler) {
      throw new Error('web.js: switchHandler: name=' + name + ' , ' +
        'this.handlers =' + this.handlers + '\n' +
        'switchHandler: switching to ' + Handler + '; sf=' + this +
        '; typeof Fetcher=' + typeof Fetcher +
        ';\n\t Fetcher.HTMLHandler=' + Fetcher.HTMLHandler + '\n' +
        '\n\tsf.handlers=' + this.handlers + '\n')
    }
    (new Handler(args)).handlerFactory(xhr, this)
    xhr.handle(cb)
  }

  checkCredentialsRetry (docuri, rterm, xhr, options) {
    if (!xhr.withCredentials) { return false }  // not dealt with

    if (xhr.retriedWithCredentials) {
      return true
    }
    xhr.retriedWithCredentials = true // protect against called twice
    console.log('web: Retrying with no credentials for ' + xhr.resource)
    xhr.abort()
    delete this.requested[docuri] // forget the original request happened
    let newopt = {}
    for (let opt in options) { // transfer baseURI etc
      if (options.hasOwnProperty(opt)) {
        newopt[opt] = options[opt]
      }
    }
    newopt.withCredentials = false
    this.addStatus(xhr.req,
      'Abort: Will retry with credentials SUPPRESSED to see if that helps')
    // userCallback already registered (with where?)
    this.requestURI(docuri, rterm, newopt, xhr.userCallback)
    return true
  }

  onerrorFactory (xhr, docuri, rterm, args, options) {
    return (event) => {
      xhr.onErrorWasCalled = true // debugging and may need it
      if (typeof document !== 'undefined') { // Mashup situation, not node etc
        if (Fetcher.crossSiteProxyTemplate && document.location && !xhr.proxyUsed) {
          const hostpart = Uri.hostpart
          const here = '' + document.location
          const uri = xhr.resource.uri
          if (hostpart(here) && hostpart(uri) && hostpart(here) !== hostpart(uri)) { // If cross-site
            if (xhr.status === 401 || xhr.status === 403 || xhr.status === 404) {
              this.onreadystatechangeFactory(xhr, docuri, rterm, args, options)()
            } else {
              // IT IS A PAIN THAT NO PROPER ERROR REPORTING
              // If credentials flag set, retry without
              if (this.checkCredentialsRetry(docuri, rterm, xhr, options)) {
                return
              }
              // If it wasn't, or we already tried that
              let newURI = Fetcher.crossSiteProxy(uri)
              console.log('web: Direct failed so trying proxy ' + newURI)
              this.addStatus(xhr.req, 'BLOCKED -> Cross-site Proxy to <' + newURI + '>')
              if (xhr.aborted) return

              let kb = this.store
              let oldreq = xhr.req
              if (!xhr.options.noMeta) {
                kb.add(oldreq, ns.http('redirectedTo'), kb.sym(newURI), oldreq)
              }
              xhr.abort()
              xhr.aborted = true

              this.addStatus(oldreq, 'redirected to new request') // why
              // the callback throws an exception when called from xhr.onerror (so removed)
              // this.fireCallbacks('done', args)
              // Are these args right? @@@   Not done yet! done means success
              this.requested[xhr.resource.uri] = 'redirected'
              this.redirectedTo[xhr.resource.uri] = newURI

              if (this.fetchCallbacks[xhr.resource.uri]) {
                if (!this.fetchCallbacks[newURI]) {
                  this.fetchCallbacks[newURI] = []
                }
                // this.fetchCallbacks[newURI] === this.fetchCallbacks[newURI].concat(this.fetchCallbacks[xhr.resource.uri])
                delete this.fetchCallbacks[xhr.resource.uri]
              }

              const xhr2 = this.requestURI(newURI, xhr.resource, xhr.options,
                xhr.userCallback)
              if (xhr2) {
                xhr2.proxyUsed = true // only try the proxy once
                xhr2.original = xhr.original
                console.log('Proxying but original still ' + xhr2.original)
              }
              if (xhr2 && xhr2.req) {
                if (!xhr.options.noMeta) {
                  kb.add(xhr.req,
                    kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'),
                    xhr2.req,
                    this.appNode)
                }
                return
              }
            }
          }
          xhr.CORS_status = 999
          // xhr.status = 999     forbidden - read-only
        }
      } // mashup
    } // function of event
  }

  // deduce some things from the HTTP transaction
  addType (cla, thisReq, kb, loc) { // add type to all redirected resources too
    let prev = thisReq
    if (loc) {
      const docURI = kb.any(prev, ns.link('requestedURI'))
      if (docURI !== loc) {
        kb.add(kb.sym(loc), ns.rdf('type'), cla, this.appNode)
      }
    }
    for (;;) {
      const doc = kb.any(prev, ns.link('requestedURI'))
      if (doc && doc.value) {
        kb.add(kb.sym(doc.value), ns.rdf('type'), cla, this.appNode)
      } // convert Literal
      prev = kb.any(undefined, kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'), prev)
      if (!prev) { break }
      var response = kb.any(prev, kb.sym('http://www.w3.org/2007/ont/link#response'))
      if (!response) { break }
      var redirection = kb.any(response, kb.sym('http://www.w3.org/2007/ont/http#status'))
      if (!redirection) { break }
      if (redirection !== '301' && redirection !== '302') { break }
    }
  }

  handleResponse (xhr, docuri, rterm, args, options) {
    if (xhr.handleResponseDone) { return }
    xhr.handleResponseDone = true
    let handler = null
    var thisReq = xhr.req // Might have changes by redirect
    this.fireCallbacks('recv', args)
    var kb = this.store
    this.saveResponseMetadata(xhr, kb)
    this.fireCallbacks('headers', [{uri: docuri, headers: xhr.headers}])

    // Check for masked errors.
    // For "security reasons" the browser hides errors such as CORS errors from
    // the calling code (2015). onerror() used to be called but is not now.
    //
    if (xhr.status === 0) {
      console.log('Masked error - status 0 for ' + xhr.resource.uri)
      if (this.checkCredentialsRetry(docuri, rterm, xhr, options)) { // retry is could be credentials flag CORS issue
        return
      }
      xhr.CORS_status = 900 // unknown masked error
      return
    }
    if (xhr.status >= 400) { // For extra dignostics, keep the reply
      //  @@@ 401 should cause  a retry with credential son
      // @@@ cache the credentials flag by host ????
      if (xhr.status === 404) {
        kb.fetcher.nonexistant[xhr.resource.uri] = true
      }
      if (xhr.responseText.length > 10) {
        let response2 = kb.bnode()
        kb.add(response2, ns.http('content'), kb.literal(xhr.responseText),
          response2)
        if (xhr.statusText) {
          kb.add(response2, ns.http('statusText'),
            kb.literal(xhr.statusText), response2)
        }
        // dump("HTTP >= 400 responseText:\n"+xhr.responseText+"\n"); // @@@@
      }
      this.failFetch(xhr, 'HTTP error for ' + xhr.resource + ': ' +
        xhr.status + ' ' + xhr.statusText)
      return
    }

    let loc =  xhr.headers['content-location']
          if (loc) {
            loc = Uri.join(loc, docuri)
          }

    // This is a minimal set to allow the use of damaged servers if necessary
    const extensionToContentType = {
      'rdf': 'application/rdf+xml',
      'owl': 'application/rdf+xml',
      'n3': 'text/n3',
      'ttl': 'text/turtle',
      'nt': 'text/n3',
      'acl': 'text/n3',
      'html': 'text/html',
      'xml': 'text/xml'
    }
    let guess
    if (xhr.status === 200) {
      this.addType(ns.link('Document'), thisReq, kb, loc)
      let ct = xhr.headers['content-type']
      if (options.forceContentType) {
        xhr.headers['content-type'] = options.forceContentType
      }
      if (!ct || ct.indexOf('application/octet-stream') >= 0) {
        guess = extensionToContentType[xhr.resource.uri.split('.').pop()]
        if (guess) {
          xhr.headers['content-type'] = guess
        }
      }
      if (ct) {
        if (ct.indexOf('image/') === 0 || ct.indexOf('application/pdf') === 0) {
          this.addType(kb.sym('http://purl.org/dc/terms/Image'), thisReq, kb, loc)
        }
      }
      if (options.clearPreviousData) { // Before we parse new data clear old but only on 200
        kb.removeDocument(xhr.resource)
      }
    }
    // application/octet-stream; charset=utf-8

    if (Uri.protocol(xhr.resource.uri) === 'file' || Uri.protocol(xhr.resource.uri) === 'chrome') {
      if (options.forceContentType) {
        xhr.headers['content-type'] = options.forceContentType
      } else {
        guess = extensionToContentType[xhr.resource.uri.split('.').pop()]
        if (guess) {
          xhr.headers['content-type'] = guess
        } else {
          xhr.headers['content-type'] = 'text/xml'
        }
      }
    }

    // If we have already got the thing at this location, abort
    if (loc) {
      let udoc = Uri.join(xhr.resource.uri, loc)
      if (!options.force && udoc !== xhr.resource.uri &&
        this.requested[udoc] && this.requested[udoc] === 'done') { // we have already fetched this in fact.
        // should we smush too?
        // log.info("HTTP headers indicate we have already" + " retrieved " + xhr.resource + " as " + udoc + ". Aborting.")
        this.doneFetch(xhr)
        xhr.abort()
        return
      }
      this.requested[udoc] = true
    }

    for (let x = 0; x < this.handlers.length; x++) {
      if (xhr.headers['content-type'] && xhr.headers['content-type'].match(this.handlers[x].pattern)) {
        handler = new this.handlers[x]()
        break
      }
    }

    this.parseLinkHeader(xhr, thisReq)

    if (handler) {
      try {
        handler.handlerFactory(xhr, this)
      } catch (e) { // Try to avoid silent errors
        this.failFetch(xhr, 'Exception handling content-type ' + xhr.headers['content-type'] + ' was: ' + e)
      }
    } else {
      this.doneFetch(xhr) //  Not a problem, we just don't extract data.
      /*
       // this.failFetch(xhr, "Unhandled content type: " + xhr.headers['content-type']+
       //        ", readyState = "+xhr.readyState)
       */
    }
  }

  // Set up callbacks
  onreadystatechangeFactory (xhr, docuri, rterm, args, options) {
    return () => {
      // DONE: 4
      // HEADERS_RECEIVED: 2
      // LOADING: 3
      // OPENED: 1
      // UNSENT: 0

      // log.debug("web.js: XHR " + xhr.resource.uri + ' readyState='+xhr.readyState); // @@@@ comment me out

      switch (xhr.readyState) {
        case 0:
          const uri = xhr.resource.uri
          let newURI
          if (this.crossSiteProxyTemplate && (typeof document !== 'undefined') && document.location) { // In mashup situation
            var hostpart = Uri.hostpart
            var here = '' + document.location
            if (hostpart(here) && hostpart(uri) && hostpart(here) !== hostpart(uri)) {
              newURI = this.crossSiteProxyTemplate.replace('{uri}', encodeURIComponent(uri))
              this.addStatus(xhr.req, 'BLOCKED -> Cross-site Proxy to <' + newURI + '>')
              if (xhr.aborted) { return }

              var kb = this.store
              var oldreq = xhr.req
              kb.add(oldreq, ns.http('redirectedTo'), kb.sym(newURI), oldreq)

              // //////////// Change the request node to a new one:  @@@@@@@@@@@@ Duplicate?
              var newreq = xhr.req = kb.bnode() // Make NEW reqest for everything else
              kb.add(oldreq, ns.http('redirectedRequest'), newreq, xhr.req)

              var now = new Date()
              var timeNow = '[' + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '] '
              kb.add(newreq, ns.rdfs('label'), kb.literal(timeNow + ' Request for ' + newURI), this.appNode)
              kb.add(newreq, ns.link('status'), kb.collection(), this.appNode)
              kb.add(newreq, ns.link('requestedURI'), kb.literal(newURI), this.appNode)

              var response = kb.bnode()
              kb.add(oldreq, ns.link('response'), response)
              // kb.add(response, ns.http('status'), kb.literal(xhr.status), response)
              // if (xhr.statusText) kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response)

              xhr.abort()
              xhr.aborted = true
              xhr.redirected = true

              this.addStatus(oldreq, 'redirected XHR') // why

              if (this.fetchCallbacks[xhr.resource.uri]) {
                if (!this.fetchCallbacks[newURI]) {
                  this.fetchCallbacks[newURI] = []
                }
                // this.fetchCallbacks[newURI] === this.fetchCallbacks[newURI].concat(this.fetchCallbacks[xhr.resource.uri])
                delete this.fetchCallbacks[xhr.resource.uri]
              }

              this.fireCallbacks('redirected', args) // Are these args right? @@@
              this.requested[xhr.resource.uri] = 'redirected'

              var xhr2 = this.requestURI(newURI, xhr.resource, xhr.options || {}, xhr.userCallback)
              if (xhr2 && xhr2.req) {
                kb.add(
                  xhr.req,
                  kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'),
                  xhr2.req, this.appNode
                )
                return
              }
            }
          }
          this.failFetch(xhr, 'HTTP Blocked. (ReadyState 0) Cross-site violation for <' +
            docuri + '>')

          break

        case 3:
          // Intermediate state -- 3 may OR MAY NOT be called, selon browser.
          // handleResponse();   // In general it you can't do it yet as the headers are in but not the data
          break
        case 4:
          // Final state for this XHR but may be redirected
          this.handleResponse(xhr, docuri, rterm, args, options)
          // Now handle
          if (xhr.handle && xhr.responseText !== undefined) { // can be validly zero length
            if (this.requested[xhr.resource.uri] === 'redirected') {
              break
            }
            this.fireCallbacks('load', args)
            xhr.handle(() => {
              this.doneFetch(xhr)
            })
          } else {
            if (xhr.redirected) {
              this.addStatus(xhr.req, 'Aborted and redirected to new request.')
            } else {
              this.addStatus(xhr.req, 'Fetch over. No data handled. Aborted = ' + xhr.aborted)
            }
            // this.failFetch(xhr, "HTTP failed unusually. (no handler set) (x-site violation? no net?) for <"+
            //    docuri+">")
          }
          break
      } // switch
    }
  }

  /**
   * Requests a document URI and arranges to load the document. This is the main
   * fetching function, used by `load()` and `nowOrWhenFetched()`.
   *
   * @param docuri {Node} Term for the thing whose URI is to be dereferenced
   *
   * @param rterm {Node} Referring term, the resource which referred to this
   *   (for tracking bad links)
   *
   * @param [options={}] {Object}
   *
   * @param [options.force] {boolean} Load the data even if loaded before.
   *   Also sets the `Cache-Control:` header to `no-cache`
   *
   * @param [options.baseURI=docuri] {Node|string} Original uri to preserve
   *   through proxying etc
   *
   * @param [options.withCredentials] {boolean} flag for XHR/CORS etc
   *
   * @param [options.clearPreviousData] {boolean} Before we parse new data,
   *   clear old, but only on status 200 responses
   *
   * @param [options.forceContentType] {string} Override the incoming header to
   *   force the data to be treated as this content-type
   *
   * @param [options.noMeta] {boolean} Prevents the addition of various metadata
   *   triples (about the fetch request) to the store
   *
   * @param [options.noRDFa] {boolean}
   *
   * @param userCallback {Function} Called with (true) or (false, errorbody,
   *   {status: 400}) after load is done or failed
   *
   * This function adds the following properties to the XHR object:
   *
   * - `xhr.handle` - The response parsing function registered by various Handler
   *     classes
   * - `xhr.options` - The `options` argument itself
   * - `xhr.req` - A Blank Node that acts as a subject for various additional
   *     metadata triples about the request itself (status, requestedUri, etc),
   *     if the `options.noMeta` flag is not set.
   * - `xhr.original` - A Named Node of `options.baseURI`
   * - `xhr.resource` - A Named Node of the `docuri` to be loaded
   * - `xhr.requestedURI` - Actual URI to be requested (could be proxied, etc)
   * - `xhr.actualProxyURI`
   * - `xhr.withCredentials`
   * - `xhr.retriedWithCredentials` - Set by `checkCredentialsRetry()` to prevent
   *     multiple retries.
   * - `xhr.onErrorWasCalled`
   * - `xhr.proxyUsed` - Set when the proxy url is tried (to prevent retries)
   * - `xhr.aborted`
   * - `xhr.handleResponseDone`
   * - `xhr.redirected`
   * - `xhr.userCallback`
   * - `xhr.CORS_status`
   * - `xhr.channel` - In Tabulator/Firefox extension environment
   *
   * @throws {Error} If it cannot set the `Accept` header
   *
   * @returns {XmlHttpRequest|undefined} The xhr object for the HTTP access,
   *   undefined if the protocol is not a look-up protocol,
   *   or URI has already been loaded
   */
  requestURI (docuri, rterm, options, userCallback) {
    // Various calling conventions
    docuri = docuri.uri || docuri // NamedNode or string
    docuri = docuri.split('#')[0]

    if (typeof options === 'boolean') {
      options = { 'force': options } // Old signature
    }
    if (typeof options === 'undefined') {
      options = {}
    }

    const force = !!options.force
    const kb = this.store
    const args = arguments
    const baseURI = options.baseURI || docuri // Preserve though proxying etc
    options.userCallback = userCallback

    let pcol = Uri.protocol(docuri)
    if (pcol === 'tel' || pcol === 'mailto' || pcol === 'urn') {
      // "No look-up operation on these, but they are not errors?"
      console.log('Unsupported protocol in: ' + docuri)
      return userCallback(false, 'Unsupported protocol', { 'status': 900 })
    }

    let docterm = kb.sym(docuri)

    let sta = this.getState(docuri)
    if (!force) {
      if (sta === 'fetched') {
        return userCallback ? userCallback(true) : undefined
      }
      if (sta === 'failed') {
        return userCallback
          ? userCallback(false, 'Previously failed. ' + this.requested[docuri],
            {'status': this.requested[docuri]})
          : undefined // An xhr standin
      }
      // if (sta === 'requested') {
      //   return userCallback
      //     ? userCallback(false,
      //       "Sorry already requested - pending already.", {'status': 999 })
      //     : undefined
      // }
    } else {
      delete this.nonexistant[docuri]
    }
    // @@ Should allow concurrent requests

    // If it is 'failed', then should we try again?
    // I think so so an old error doesn't get stuck
    // if (sta === 'unrequested')

    this.fireCallbacks('request', args) // Kenny: fire 'request' callbacks here
    // dump( "web.js: Requesting uri: " + docuri + "\n" )

    if (userCallback) {
      if (!this.fetchCallbacks[docuri]) {
        this.fetchCallbacks[docuri] = [ userCallback ]
      } else {
        this.fetchCallbacks[docuri].push(userCallback)
      }
    }

    if (this.requested[docuri] === true) {
      return // Don't ask again - wait for existing call
    } else {
      this.requested[docuri] = true
    }

    if (!options.noMeta && rterm && rterm.uri) {
      kb.add(docterm.uri, ns.link('requestedBy'), rterm.uri, this.appNode)
    }

    const xhr = Util.XMLHTTPFactory()
    xhr.req = kb.bnode()
    let req = xhr.req
    xhr.original = kb.sym(baseURI)
    // console.log('XHR original: ' + xhr.original)
    xhr.options = options
    xhr.resource = docterm // This might be proxified
    xhr.userCallback = userCallback

    const now = new Date()
    const timeNow = '[' + now.getHours() + ':' + now.getMinutes() + ':' +
      now.getSeconds() + '] '

    if (!options.noMeta) {
      kb.add(req, ns.rdfs('label'),
        kb.literal(timeNow + ' Request for ' + docuri), this.appNode)
      kb.add(req, ns.link('requestedURI'), kb.literal(docuri), this.appNode)
      kb.add(req, ns.link('status'), kb.collection(), this.appNode)
    }

    // Map the URI to a localhost proxy if we are running on localhost
    // This is used for working offline, e.g. on planes.
    // Is the script itself is running in localhost, then access all
    //   data in a localhost mirror.
    // Do not remove without checking with TimBL
    let uri2 = docuri
    if (typeof tabulator !== 'undefined' &&
        tabulator.preferences.get('offlineModeUsingLocalhost')) {
      if (uri2.slice(0, 7) === 'http://' && uri2.slice(7, 17) !== 'localhost/') {
        uri2 = 'http://localhost/' + uri2.slice(7)
        log.warn('Localhost kludge for offline use: actually getting <' +
          uri2 + '>')
      } else {
        // log.warn("Localhost kludge NOT USED <" + uri2 + ">")
      }
    } else {
      // log.warn("Localhost kludge OFF offline use: actually getting <" +
      //   uri2 + ">")
    }
    // 2014 problem:
    // XMLHttpRequest cannot load http://www.w3.org/People/Berners-Lee/card.
    // A wildcard '*' cannot be used in the 'Access-Control-Allow-Origin'
    //   header when the credentials flag is true.
    // @ Many ontology files under http: and need CORS wildcard ->
    //   can't have withCredentials

    // @@ Kludge -- need for webid which typically is served from https
    let withCredentials = (uri2.slice(0, 6) === 'https:')

    if (options.withCredentials !== undefined) {
      withCredentials = options.withCredentials
    }
    let actualProxyURI = this.proxyIfNecessary(uri2)

    // Setup the request
    xhr.onerror = this.onerrorFactory(xhr, docuri, rterm, args, options)
    xhr.onreadystatechange = this.onreadystatechangeFactory(xhr, docuri, rterm, args, options)
    xhr.timeout = this.timeout
    xhr.withCredentials = withCredentials
    xhr.actualProxyURI = actualProxyURI

    xhr.options = options
    xhr.resource = docterm
    xhr.requestedURI = uri2

    xhr.ontimeout = () => {
      this.failFetch(xhr, 'requestTimeout')
    }
    try {
      xhr.open('GET', actualProxyURI, this.async)
    } catch (er) {
      return this.failFetch(xhr, 'XHR open for GET failed for <' + uri2 + '>:\n\t' + er)
    }
    if (force) { // must happen after open
      xhr.setRequestHeader('Cache-control', 'no-cache')
    }

    // Set redirect callback and request headers -- alas Firefox Extension Only
    if (typeof tabulator !== 'undefined' &&
        tabulator.isExtension && xhr.channel &&
        (Uri.protocol(xhr.resource.uri) === 'http' ||
         Uri.protocol(xhr.resource.uri) === 'https')) {
      try {
        xhr.channel.notificationCallbacks = this.channelNotificationCallbacks(xhr, rterm)
      } catch (err) {
        return this.failFetch(xhr,
          "@@ Couldn't set callback for redirects: " + err)
      } // try
    } // if Firefox extension

    try {
      let acceptstring = ''
      for (let type in this.mediatypes) {
        // var attrstring = ''
        if (acceptstring !== '') {
          acceptstring += ', '
        }
        acceptstring += type
        for (let attr in this.mediatypes[type]) {
          acceptstring += ';' + attr + '=' + this.mediatypes[type][attr]
        }
      }
      xhr.setRequestHeader('Accept', acceptstring)
      this.addStatus(xhr.req, 'Accept: ' + acceptstring)

      // if (requester) { xhr.setRequestHeader('Referer',requester) }
    } catch (err) {
      throw new Error("Can't set Accept header: " + err)
    }

    // Fire
    try {
      xhr.send(null)
    } catch (er) {
      return this.failFetch(xhr, 'XHR send failed:' + er)
    }

    setTimeout(() => {
      if (xhr.readyState !== 4 && this.isPending(xhr.resource.uri)) {
        this.failFetch(xhr, 'requestTimeout')
      }
    }, this.timeout)

    this.addStatus(xhr.req, 'HTTP Request sent.')

    return xhr
  } // this.requestURI()

  channelNotificationCallbacks (xhr, rterm) {
    return {
      getInterface: (iid) => {
        if (iid.equals(Components.interfaces.nsIChannelEventSink)) {
          return {
            // See https://developer.mozilla.org/en/XPCOM_Interface_Reference/nsIChannelEventSink
            asyncOnChannelRedirect: (oldC, newC, flags, callback) => {
              if (xhr.aborted) return
              var kb = this.store
              var newURI = newC.URI.spec
              var oldreq = xhr.req
              this.addStatus(xhr.req, 'Redirected: ' + xhr.status + ' to <' + newURI + '>')
              kb.add(oldreq, ns.http('redirectedTo'), kb.sym(newURI), xhr.req)

              // //////////// Change the request node to a new one:  @@@@@@@@@@@@ Duplicate?
              var newreq = xhr.req = kb.bnode() // Make NEW reqest for everything else
              // xhr.resource = docterm
              // xhr.requestedURI = args[0]

              // kb.add(kb.sym(newURI), ns.link("request"), req, this.appNode)
              kb.add(oldreq, ns.http('redirectedRequest'), newreq, xhr.req)

              var now = new Date()
              var timeNow = '[' + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '] '
              kb.add(newreq, ns.rdfs('label'), kb.literal(timeNow + ' Request for ' + newURI), this.appNode)
              kb.add(newreq, ns.link('status'), kb.collection(), this.appNode)
              kb.add(newreq, ns.link('requestedURI'), kb.literal(newURI), this.appNode)
              // /////////////

              // // log.info('@@ sources onChannelRedirect'+
              //               "Redirected: "+
              //               xhr.status + " to <" + newURI + ">"); //@@
              var response = kb.bnode()
              // kb.add(response, ns.http('location'), newURI, response); Not on this response
              kb.add(oldreq, ns.link('response'), response)
              kb.add(response, ns.http('status'), kb.literal(xhr.status), response)
              if (xhr.statusText) kb.add(response, ns.http('statusText'), kb.literal(xhr.statusText), response)

              if (xhr.status - 0 !== 303) kb.HTTPRedirects[xhr.resource.uri] = newURI // same document as
              if (xhr.status - 0 === 301 && rterm) { // 301 Moved
                var badDoc = Uri.docpart(rterm.uri)
                var msg = 'Warning: ' + xhr.resource + ' has moved to <' + newURI + '>.'
                if (rterm) {
                  msg += ' Link in <' + badDoc + ' >should be changed'
                  kb.add(badDoc, kb.sym('http://www.w3.org/2007/ont/link#warning'), msg, this.appNode)
                }
                // dump(msg+"\n")
              }
              xhr.abort()
              xhr.aborted = true

              var hash = newURI.indexOf('#')
              if (hash >= 0) {
                var msg2 = ('Warning: ' + xhr.resource + ' HTTP redirects to' + newURI + ' which do not normally contain a "#" sign')
                // dump(msg+"\n")
                kb.add(xhr.resource, kb.sym('http://www.w3.org/2007/ont/link#warning'), msg2)
                newURI = newURI.slice(0, hash)
              }
              /*
               if (sf.fetchCallbacks[xhr.resource.uri]) {
               if (!sf.fetchCallbacks[newURI]) {
               sf.fetchCallbacks[newURI] = []
               }
               sf.fetchCallbacks[newURI] = sf.fetchCallbacks[newURI].concat(sf.fetchCallbacks[xhr.resource.uri])
               delete sf.fetchCallbacks[xhr.resource.uri]
               }
               */
              this.requested[xhr.resource.uri] = 'redirected'
              this.redirectedTo[xhr.resource.uri] = newURI

              let xhr2 = this.requestURI(newURI, xhr.resource, xhr.options, xhr.userCallback)
              if (xhr2) { // may be no XHR is other URI already loaded
                xhr2.original = xhr.original // use this for finding base
                if (xhr2.req) {
                  kb.add(
                    xhr.req,
                    kb.sym('http://www.w3.org/2007/ont/link#redirectedRequest'),
                    xhr2.req,
                    this.appNode
                  )
                }
              }
              // else dump("No xhr.req available for redirect from "+xhr.resource+" to "+newURI+"\n")
            } // asyncOnChannelRedirect
          }
        }
        return Components.results.NS_NOINTERFACE
      }
    }
  }

  // var updatesVia = new $rdf.UpdatesVia(this) // Subscribe to headers
// @@@@@@@@ This is turned off because it causes a websocket to be set up for ANY fetch
// whether we want to track it ot not. including ontologies loaed though the XSSproxy
}

module.exports = Fetcher
