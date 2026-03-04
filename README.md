# diii

a web-based alternative to the python-based diii CLI

to run locally run this in the web-diii root directory then browse to localhost:8000
```bash
python3 -m http.server 8000
```

## Optional websocket bridge (opt-in)

The bridge is disabled by default.

To enable it in the app UI:

1. Click the gear button next to `documentation` in the top-right header.
2. Enter a websocket server URL (for example `ws://localhost:9000` or `wss://example.com/ws`).
3. Connect your iii device.

To disable the bridge, open settings again and submit a blank value.
