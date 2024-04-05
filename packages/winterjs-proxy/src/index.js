
// Handler function.
// Receives a request and returns a response.
async function handleRequest(ev) {
  const request = ev.request;

  const url = new URL(request.url);
  const path = url.pathname.slice(1);

  let res;
  try {
    console.log('sending fetch request', {url: path});
    res = await fetch(path);
    console.log('response', {url: res.url, status: res.status});
  } catch (err) {
    res = new Response(JSON.stringify({ error: err.message }), {
      status: 500,
    });
  }

  return res;
}

// Register the listener that handles incoming requests.
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
