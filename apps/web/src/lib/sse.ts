export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental parser for `text/event-stream`: feed it text chunks, it returns the messages completed so far. */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    // A lone trailing \r might be the first half of \r\n; hold it back until the next chunk.
    const hold = this.buf.endsWith('\r') ? 1 : 0;
    const complete = this.buf.slice(0, this.buf.length - hold);
    const lines = complete.split(/\r\n|\n|\r/);
    this.buf = lines.pop()! + this.buf.slice(this.buf.length - hold);

    const out: SseMessage[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    return out;
  }
}
