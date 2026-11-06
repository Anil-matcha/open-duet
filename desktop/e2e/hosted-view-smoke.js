// Manual check (needs network): npx electron e2e/hosted-view-smoke.js. Loads the real hosted site in the isolated view.
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const path = require("node:path");
const H = require(path.join(__dirname, "..", "src/hosted-workspace.js"));
app.whenReady().then(async () => {
  app.setPath("userData", require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "hosted-smoke-")));
  const window = new BrowserWindow({ width: 900, height: 700, show: false });
  window.loadURL("about:blank");
  const hosted = H.createHostedWorkspace({ window, WebContentsView, session, openExternal: (u) => console.log("external", u) });
  hosted.show("hosted");
  const c = hosted.hostedContents();
  await new Promise((r) => { c.once("did-finish-load", r); setTimeout(r, 20000); });
  console.log("url", c.getURL(), "title", await c.executeJavaScript("document.title"));
  console.log("openDots exposed:", await c.executeJavaScript("typeof window.openDots"), "process:", await c.executeJavaScript("typeof process"), "require:", await c.executeJavaScript("typeof require"));
  console.log("cookies partition ok:", c.session === session.fromPartition(H.HOSTED_PARTITION), "!= default:", c.session !== session.defaultSession);
  console.log("body:", (await c.executeJavaScript("document.body.innerText")).slice(0, 200).replace(/\n/g, " | "));
  await hosted.signOut();
  hosted.show("local");
  console.log("current", hosted.current());
  app.quit();
});
