"""Exercise the actual verifier in native Safari via Apple's local WebDriver on macOS."""
import argparse
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import subprocess
from threading import Thread
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

def webdriver(url, method="GET", body=None, timeout=40):
    data = None if body is None else json.dumps(body).encode()
    request = Request(url, data=data, method=method, headers={"Content-Type":"application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)["value"]
    except HTTPError as error:
        raise RuntimeError(f"SafariDriver {error.code}: {error.read(1024).decode(errors='replace')}") from error

def simulator_device(requested=None):
    result = subprocess.run(["xcrun", "simctl", "list", "devices", "booted", "-j"],
                            check=True, capture_output=True, text=True, timeout=10)
    devices = [{"udid":device["udid"],"name":device["name"],"runtime":runtime}
               for runtime, group in json.loads(result.stdout)["devices"].items()
               if ".iOS-" in runtime
               for device in group if device.get("state") == "Booted" and device.get("isAvailable", True)]
    print(json.dumps({"safari_step":"simulator.booted_devices","devices":devices}),flush=True)
    selected = [device for device in devices if not requested or device["udid"] == requested]
    if len(selected) != 1:
        raise RuntimeError("Select exactly one booted iOS device with --simulator-udid; matching devices="+str(len(selected)))
    return selected[0]["udid"]


def run(harness, extension=None, ios_simulator=False, simulator_udid=None, *,
        install_only=False):
    if ios_simulator:
        simulator_udid = simulator_device(simulator_udid)
        print(json.dumps({"safari_step":"simulator.launch_safari","udid":simulator_udid}),flush=True)
        subprocess.run(["xcrun", "simctl", "launch", simulator_udid, "com.apple.mobilesafari"], check=True, timeout=30)
    with socket.socket() as port:
        port.bind(("127.0.0.1",0))
        driver_port = port.getsockname()[1]
    driver_url = f"http://127.0.0.1:{driver_port}"
    server = ThreadingHTTPServer(("127.0.0.1",0),partial(SimpleHTTPRequestHandler,directory=str(harness)))
    Thread(target=server.serve_forever,daemon=True).start()
    driver = subprocess.Popen(["/usr/bin/safaridriver","-p",str(driver_port)])
    session = None
    try:
        deadline = monotonic()+15
        while monotonic()<deadline:
            try:
                webdriver(driver_url+"/status", timeout=3)
                break
            except URLError:
                sleep(.25)
        capabilities = {"browserName":"Safari"}
        if ios_simulator:
            capabilities.update({"platformName":"ios", "safari:useSimulator":True,
                                 "safari:deviceUDID":simulator_udid})
        print(json.dumps({"safari_step":"session.begin", "capabilities":capabilities}),flush=True)
        started = monotonic()
        try:
            created = webdriver(driver_url+"/session","POST",{"capabilities":{"alwaysMatch":capabilities}},timeout=60)
        except (RuntimeError, TimeoutError, URLError) as error:
            print(json.dumps({"safari_step":"session.failed","elapsedSeconds":round(monotonic()-started,1),
                              "error":str(error)[:1000],"iosSimulator":ios_simulator,
                              "simulatorUDID":simulator_udid,
                              "note":"Simulator must expose Safari through Web Inspector and Remote Automation; no preference or access-control bypass is applied."}),flush=True)
            if ios_simulator:
                simulator_device(simulator_udid)
            raise
        session = driver_url+"/session/"+created["sessionId"]
        print(json.dumps({"safari_step":"session.created", "browserVersion":created["capabilities"].get("browserVersion"),
                          "platformName":created["capabilities"].get("platformName"), "iosSimulator":ios_simulator}),flush=True)
        webdriver(session+"/timeouts","POST",{"script":35000,"pageLoad":25000,"implicit":0})
        webdriver(session+"/url","POST",{"url":f"http://127.0.0.1:{server.server_port}/"})
        fixtures = Path(__file__).resolve().parents[1]/"fixtures/provenance"
        manifest = json.loads((fixtures/"manifest.json").read_text())
        results = []
        for row in manifest["assets"]:
            print(json.dumps({"safari_step":"fixture.begin", "fixture":row["file"]}),flush=True)
            file = fixtures/row["file"]
            mime = {".jpg":"image/jpeg",".png":"image/png",".mp4":"video/mp4"}[file.suffix]
            value = webdriver(session+"/execute/async","POST",{
                "script":"const [data,mime,done]=arguments; window.verifyFixture(data,mime).then(done,e=>done({error:String(e)}));",
                "args":[base64.b64encode(file.read_bytes()).decode(),mime]})
            assert value["status"] == row["expected"], (file.name,value,row["expected"])
            assert value["shouldLabel"] is (row["expected"]=="verified-generated")
            results.append((file.name,value["status"]))
            print(json.dumps({"safari_step":"fixture.complete", "fixture":file.name,"status":value["status"]}),flush=True)
        print(json.dumps({"native_safari_verifier":results}),flush=True)
        if extension:
            from safari_extension import run_extension, run_install_smoke
            if install_only:
                result = run_install_smoke(session, webdriver, extension)
            else:
                result = run_extension(session, webdriver, extension)
            print(json.dumps({"native_safari_extension":result,"ios_simulator":ios_simulator}),flush=True)
    finally:
        try:
            if session:
                webdriver(session,"DELETE")
        finally:
            driver.terminate()
            driver.wait(timeout=10)
            server.shutdown()
            server.server_close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("harness",type=Path)
    parser.add_argument("--extension",type=Path,help="Path to the packaged Safari WebExtension")
    parser.add_argument("--install-only", action="store_true", help="Verify native installation of the exact package; does not exercise the overlay")
    parser.add_argument("--ios-simulator",action="store_true",help="Run the same checks in native Safari on an available iOS Simulator")
    parser.add_argument("--simulator-udid",help="Exact booted iOS Simulator UDID; otherwise require exactly one booted iOS device")
    args=parser.parse_args()
    if args.simulator_udid and not args.ios_simulator:
        parser.error("--simulator-udid requires --ios-simulator")
    if args.install_only and not args.extension:
        parser.error("The extension test mode requires --extension")
    run(args.harness,args.extension,args.ios_simulator,args.simulator_udid,
        install_only=args.install_only)
