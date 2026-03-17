import asyncio

import httpx
from fastapi import FastAPI, Request

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello World"}


async def do_request(request: Request, async_mode: bool):
    payload = await request.json()
    timeout_s = payload["timeout_ms"] / 1000
    start = asyncio.get_running_loop().time()
    try:
        if async_mode:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                response = await client.request(payload["method"], payload["target"])
        else:
            response = httpx.request(
                payload["method"], payload["target"], timeout=timeout_s
            )
        return {
            "body": response.text,
            "status_code": response.status_code,
            "elapsed_time_ms": int((asyncio.get_running_loop().time() - start) * 1000),
        }
    except Exception as exc:
        return {
            "error": str(exc),
            "status_code": 500,
            "elapsed_time_ms": int((asyncio.get_running_loop().time() - start) * 1000),
        }


@app.post("/async")
async def req_async(request: Request):
    return await do_request(request, async_mode=True)


@app.post("/sync")
async def req_sync(request: Request):
    return await do_request(request, async_mode=False)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
