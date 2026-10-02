// Stream oversized Unity data from smaller static files without changing its bytes.
window.PokerSplitAsset = function (asset) {
  const originalFetch = window.fetch.bind(window);
  const target = new URL(asset.url, location.href).href;
  const headers = {'Content-Type':'application/octet-stream','Content-Length':String(asset.length),'ETag':'"'+asset.hash+'"'};
  window.fetch = function (input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href).href;
    if (url.split('?')[0] !== target) return originalFetch(input, options);
    const method = (options?.method || input?.method || 'GET').toUpperCase();
    if (method === 'HEAD') return Promise.resolve(new Response(null, {status:200,headers}));
    if (method !== 'GET') return originalFetch(input, options);
    const callerSignal=options?.signal || input?.signal;
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason || new DOMException('Aborted','AbortError'));
    const downloadController=new AbortController();
    let index=0, reader=null, nextPart=null, stopped=false, streamController=null;
    const unlink=()=>callerSignal?.removeEventListener('abort',abort);
    const cancelPending=reason=>nextPart?.then(result=>result.response?.body?.cancel(reason)).catch(()=>{});
    function abort() {
      if (stopped) return;
      stopped=true;
      const reason=callerSignal.reason || new DOMException('Aborted','AbortError');
      downloadController.abort(reason);
      unlink();
      streamController.error(reason);
      reader?.cancel(reason).catch(()=>{});
      cancelPending(reason);
    }
    function fetchPart() {
      const partUrl=new URL(asset.parts[index++],location.href);
      partUrl.searchParams.set('v',asset.hash);
      // Keep only the current part and one upcoming part in flight. Each file
      // is capped by the packager at 8 MiB. Settling errors as values prevents
      // a prefetched failure becoming an unhandled rejection while reading.
      return originalFetch(partUrl.href,{signal:downloadController.signal})
        .then(response=>({response}),error=>({error}));
    }
    const stream = new ReadableStream({
      start(controller) {
        streamController=controller;
        callerSignal?.addEventListener('abort',abort,{once:true});
        if (callerSignal?.aborted) abort();
      },
      async pull(controller) {
        try {
          while (true) {
            if (stopped) return;
            if (!reader) {
              if (!nextPart && index >= asset.parts.length) {stopped=true;unlink();controller.close();return;}
              if (!nextPart) nextPart=fetchPart();
              const result=await nextPart;
              nextPart=null;
              if (stopped) {result.response?.body?.cancel().catch(()=>{});return;}
              if (result.error) throw result.error;
              const response=result.response;
              if (!response.ok || !response.body) throw new Error('Nie udało się pobrać części gry: '+response.status);
              reader=response.body.getReader();
              if (index < asset.parts.length) nextPart=fetchPart();
            }
            const chunk=await reader.read();
            if (stopped) return;
            if (chunk.done) {reader.releaseLock();reader=null;continue;}
            controller.enqueue(chunk.value);return;
          }
        } catch(error) {
          if (stopped) return;
          stopped=true;unlink();downloadController.abort(error);
          reader?.cancel(error).catch(()=>{});cancelPending(error);
          controller.error(error);
        }
      },
      cancel(reason) {
        stopped=true;unlink();downloadController.abort(reason);cancelPending(reason);
        return reader?.cancel(reason);
      }
    });
    const response=new Response(stream,{status:200,headers});
    Object.defineProperty(response,'url',{value:url});
    return Promise.resolve(response);
  };
};
