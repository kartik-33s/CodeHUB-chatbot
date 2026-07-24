const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const { pathToFileURL } = require("url");

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9224;
const userData = path.resolve("india-is-one-of-the-world", "work", "chrome-profile-verify");
const url = pathToFileURL(path.resolve("india-is-one-of-the-world", "outputs", "index.html")).href;
const proc = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userData}`,
  url,
], { stdio: ["ignore", "ignore", "pipe"] });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathname}`, response => {
      let data = "";
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();

    ws.onopen = () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const messageId = ++id;
            pending.set(messageId, { res, rej });
            ws.send(JSON.stringify({ id: messageId, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    };

    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const callbacks = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) callbacks.rej(new Error(JSON.stringify(message.error)));
        else callbacks.res(message.result);
      }
    };

    ws.onerror = reject;
  });
}

(async () => {
  try {
    let targets = [];
    for (let i = 0; i < 30; i += 1) {
      try {
        targets = await getJson("/json/list");
        if (targets.length) break;
      } catch (error) {
        // Chrome is still starting.
      }
      await wait(250);
    }

    const page = targets.find(target => target.type === "page");
    if (!page) throw new Error("No page target found");

    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    async function checkViewport(name, width, height) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 600,
      });
      await cdp.send("Page.reload", { ignoreCache: true });
      await wait(1000);

      const expression = `({
        viewport: "${name}",
        cards: document.querySelectorAll(".indicator").length,
        h1: document.querySelector("h1")?.textContent,
        insight: document.querySelector("#insightText")?.textContent,
        sourceRows: document.querySelectorAll("#sourceRows tr").length,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      })`;

      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      return result.result.value;
    }

    const results = [
      await checkViewport("desktop", 1440, 1100),
      await checkViewport("mobile", 390, 1200),
    ];

    console.log(JSON.stringify(results, null, 2));
    cdp.close();
    proc.kill();

    if (results.some(value => (
      value.cards !== 13 ||
      value.sourceRows !== 13 ||
      !value.insight ||
      value.scrollWidth > value.innerWidth + 2
    ))) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error.stack || error.message);
    proc.kill();
    process.exit(1);
  }
})();
