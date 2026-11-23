# 使い捨てプロファイルのヘッドレス Chrome に拡張を読み込み、DevTools プロトコル (パイプ) で操作する小さなドライバ。
# 普段使いの Chrome やプロファイルには触れない (一時ディレクトリのプロファイルを作って終了時に消す)。
# Chrome 137 以降は --load-extension が使えないため、--remote-debugging-pipe + Extensions.loadUnpacked を使う。
import json, os, subprocess, sys, tempfile, time, shutil, select

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

class Chrome:
    def __init__(self, ext_path, headless=True):
        self.profile = tempfile.mkdtemp(prefix="arcsp-e2e-", dir=os.environ.get("TMPDIR"))
        r_to_chrome, w_to_chrome = os.pipe()
        r_from_chrome, w_from_chrome = os.pipe()
        # Chrome はパイプモードで fd 3 を読み、fd 4 に書く
        def preexec():
            # os.pipe() の fd は exec で閉じる設定なので、3/4 に複製したうえで継承可能にする
            a, b = os.dup(r_to_chrome), os.dup(w_from_chrome)
            os.dup2(a, 3); os.dup2(b, 4)
            os.set_inheritable(3, True); os.set_inheritable(4, True)
        args = [CHROME, f"--user-data-dir={self.profile}", "--remote-debugging-pipe",
                "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
                "--disable-sync", "--password-store=basic", "--use-mock-keychain", "about:blank"]
        if headless: args.insert(1, "--headless=new")
        self.proc = subprocess.Popen(args, close_fds=False, preexec_fn=preexec,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(r_to_chrome); os.close(w_from_chrome)
        self.w = w_to_chrome; self.r = r_from_chrome
        self.buf = b""; self.next_id = 0; self.events = []
        self.ext_id = self.send("Extensions.loadUnpacked", {"path": ext_path})["id"]

    def _read_msg(self, timeout):
        end = time.time() + timeout
        while b"\0" not in self.buf:
            left = end - time.time()
            if left <= 0: raise TimeoutError("cdp read timeout")
            rr, _, _ = select.select([self.r], [], [], left)
            if rr:
                chunk = os.read(self.r, 1 << 20)
                if not chunk: raise EOFError("chrome closed pipe")
                self.buf += chunk
        msg, self.buf = self.buf.split(b"\0", 1)
        return json.loads(msg)

    def send(self, method, params=None, session=None, timeout=30):
        self.next_id += 1
        mid = self.next_id
        m = {"id": mid, "method": method, "params": params or {}}
        if session: m["sessionId"] = session
        os.write(self.w, json.dumps(m).encode() + b"\0")
        while True:
            msg = self._read_msg(timeout)
            if msg.get("id") == mid:
                if "error" in msg: raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            self.events.append(msg)

    def open(self, url):
        tid = self.send("Target.createTarget", {"url": url})["targetId"]
        sid = self.send("Target.attachToTarget", {"targetId": tid, "flatten": True})["sessionId"]
        self.send("Runtime.enable", session=sid)
        return tid, sid

    def eval(self, sid, expr, timeout=30):
        r = self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, session=sid, timeout=timeout)
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:800])
        return r["result"].get("value")

    def close(self):
        try: self.send("Browser.close", timeout=5)
        except Exception: pass
        try: self.proc.wait(timeout=10)
        except Exception: self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)
