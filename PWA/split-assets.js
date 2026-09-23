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
    let index=0, reader=null;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            if (!reader) {
              if (index >= asset.parts.length) {controller.close();return;}
              const partUrl=new URL(asset.parts[index++], location.href);
              partUrl.searchParams.set('v',asset.hash);
              const response=await originalFetch(partUrl.href,{signal:options?.signal});
              if (!response.ok || !response.body) throw new Error('Nie udało się pobrać części gry: '+response.status);
              reader=response.body.getReader();
            }
            const chunk=await reader.read();
            if (chunk.done) {reader.releaseLock();reader=null;continue;}
            controller.enqueue(chunk.value);return;
          }
        } catch(error) {controller.error(error);}
      },
      cancel(reason) {return reader?.cancel(reason);}
    });
    const response=new Response(stream,{status:200,headers});
    Object.defineProperty(response,'url',{value:url});
    return Promise.resolve(response);
  };
};
