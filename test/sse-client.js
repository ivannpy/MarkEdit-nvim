'use strict';

// A small EventSource implementation over node:http, only for the end-to-end
// test (Node does not ship EventSource without a flag). It covers what the
// extension uses: addEventListener, onerror, close and readyState.

const http = require('node:http');

class SseClient {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.onerror = null;
    this.buffer = '';

    this.request = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        this.readyState = 2;
        res.resume();
        this.fire();
        return;
      }
      this.readyState = 1;
      res.setEncoding('utf8');
      res.on('data', (chunk) => this.consume(chunk));
      res.on('end', () => this.fire());
      res.on('error', () => this.fire());
    });
    this.request.on('error', () => this.fire());
  }

  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  }

  consume(chunk) {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end === -1) {
        return;
      }
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let name = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
          name = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
        }
      }
      if (data.length > 0) {
        for (const fn of this.listeners[name] || []) {
          fn({ data: data.join('\n') });
        }
      }
    }
  }

  fire() {
    if (this.readyState !== 2 && this.onerror) {
      this.onerror(new Error('stream ended'));
    }
  }

  close() {
    this.readyState = 2;
    this.request.destroy();
  }
}

module.exports = { SseClient };
