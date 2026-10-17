// Bounded, retryable downloads. Gzip is decoded by the browser, part by part;
// Unity receives exactly the original bytes, without a second whole archive.
window.PokerSplitAsset = function (asset) {
  const originalFetch = window.fetch.bind(window);
  const target = new URL(asset.url, location.href).href;
  let compressed = false;
  try { compressed = !!asset.compressedParts && typeof DecompressionStream === 'function' && !!new DecompressionStream('gzip'); } catch (_) {}
  const encoded = asset.parts.map((_,i) => compressed && (!asset.compressedSizes || !asset.partSizes || asset.compressedSizes[i] < asset.partSizes[i]));
  const paths = asset.parts.map((path,i) => encoded[i] ? asset.compressedParts[i] : path);
  const sizes = asset.partSizes && asset.parts.map((_,i) => encoded[i] ? asset.compressedSizes[i] : asset.partSizes[i]);
  const progress = window.PokerDownloadProgress ||= { loaded: 0, total: 0 };
  progress.total += sizes ? sizes.reduce((a,b) => a+b, 0) : asset.length;
  const received = paths.map(() => 0);
  const headers = {'Content-Type':asset.contentType || 'application/octet-stream','Content-Length':String(asset.length),'ETag':'"'+asset.hash+'"'};
  function report(index, bytes) {
    const value = Math.max(received[index], bytes);
    progress.loaded += value - received[index]; received[index] = value;
  }
  window.fetch = function (input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href).href;
    if (url.split('?')[0] !== target) return originalFetch(input, options);
    const method = (options?.method || input?.method || 'GET').toUpperCase();
    if (method === 'HEAD') return Promise.resolve(new Response(null, {status:200,headers}));
    if (method !== 'GET') return originalFetch(input, options);
    const callerSignal = options?.signal || input?.signal;
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason || new DOMException('Aborted','AbortError'));
    const download = new AbortController();
    let index = 0, current = null, next = null, stopped = false, streamController;
    const unlink = () => callerSignal?.removeEventListener('abort',abort);
    function abort() {
      if (stopped) return;
      stopped = true; unlink();
      const error = callerSignal.reason || new DOMException('Aborted','AbortError');
      download.abort(error); streamController.error(error);
    }
    function deadline(promise, attempt) {
      let timer, cancel;
      const cancelled = new Promise((_,reject) => {
        cancel = () => reject(attempt.signal.reason || new DOMException('Aborted','AbortError'));
        attempt.signal.addEventListener('abort',cancel,{once:true});
        if (attempt.signal.aborted) cancel();
      });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error('Pobieranie gry nie odpowiada. Sprawdź połączenie i spróbuj ponownie.');
        attempt.abort(error); reject(error);
      }, 30000); });
      return Promise.race([promise, timeout, cancelled]).finally(() => {
        clearTimeout(timer);attempt.signal.removeEventListener('abort',cancel);
      });
    }
    async function readPart(part) {
      let failure;
      for (let retry = 0; retry < 3; retry++) {
        const attempt = new AbortController();
        const cancel = () => attempt.abort(download.signal.reason);
        download.signal.addEventListener('abort',cancel,{once:true});
        let wireReader, reader;
        try {
          if (download.signal.aborted) throw download.signal.reason;
          const partUrl = new URL(paths[part],location.href); partUrl.searchParams.set('v',asset.hash);
          const response = await deadline(originalFetch(partUrl.href,{signal:attempt.signal,cache:retry>0?'reload':'default'}),attempt);
          if (!response.ok || !response.body) throw new Error('Nie udało się pobrać części gry: '+response.status);
          wireReader = response.body.getReader(); let wireBytes = 0;
          const wire = new ReadableStream({
            async pull(controller) {
              try {
                const chunk = await deadline(wireReader.read(),attempt);
                if (chunk.done) {controller.close();return;}
                wireBytes += chunk.value.byteLength;
                if (wireBytes > 8*1024*1024+65536) throw new Error('Część gry przekracza limit pamięci.');
                report(part,wireBytes); controller.enqueue(chunk.value);
              } catch (error) { controller.error(error); }
            },
            cancel(reason) { safelyCancel(wireReader,reason); }
          },{highWaterMark:0});
          reader = (encoded[part] ? wire.pipeThrough(new DecompressionStream('gzip')) : wire).getReader();
          const chunks = []; let length = 0;
          while (true) {
            const chunk = await deadline(reader.read(),attempt);
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 8*1024*1024) throw new Error('Rozpakowana część gry przekracza limit pamięci.');
            chunks.push(chunk.value);
          }
          if (asset.partSizes && length !== asset.partSizes[part]) throw new Error('Niekompletna część gry.');
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.byteLength;}
          if (asset.partHashes) {
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
            if (hash !== asset.partHashes[part]) throw new Error('Część gry jest uszkodzona.');
          }
          return {bytes};
        } catch (error) {
          failure = error; attempt.abort(error);
          if (download.signal.aborted) return {error:download.signal.reason || error};
        } finally {
          safelyCancel(reader,failure); safelyCancel(wireReader,failure);
          download.signal.removeEventListener('abort',cancel);
        }
      }
      return {error:failure};
    }
    function safelyCancel(reader,reason) { try { reader?.cancel(reason).catch(()=>{}); } catch (_) {} }
    const fetchPart = () => readPart(index++).catch(error=>({error}));
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller; callerSignal?.addEventListener('abort',abort,{once:true});
        if (callerSignal?.aborted) abort();
      },
      async pull(controller) {
        try {
          if (stopped) return;
          if (!current && index < paths.length) current = fetchPart();
          if (!current) {stopped=true;unlink();controller.close();return;}
          if (!next && index < paths.length) next = fetchPart();
          const result = await current;
          current = next; next = null;
          if (stopped) return;
          if (result.error) throw result.error;
          controller.enqueue(result.bytes);
        } catch (error) {
          if (stopped) return;
          stopped=true;unlink();download.abort(error);controller.error(error);
        }
      },
      cancel(reason) {stopped=true;unlink();download.abort(reason);}
    },{highWaterMark:0});
    const response = new Response(stream,{status:200,headers});
    Object.defineProperty(response,'url',{value:url}); return Promise.resolve(response);
  };
};
