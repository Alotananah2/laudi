#!/usr/bin/env python3
"""Laudi's ears on the server: listens all the time (offline, nothing is uploaded).
Say "wake up" and he answers "I'm already awake!" out loud."""
import json, os, random, subprocess, sys, tempfile, time

DIR = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(DIR, "model")
PHRASE = os.environ.get("WAKE_PHRASE", "wake up")
ANSWER = os.environ.get("WAKE_ANSWER", "I'm already awake!")
VOICE = os.environ.get("EDGE_VOICE", "en-US-AndrewNeural")
RATE = 16000


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def say(text):
    """Speak through the server's speakers: natural voice (edge-tts), robot voice as a backup."""
    mp3 = os.path.join(tempfile.gettempdir(), "laudi-say.mp3")
    try:
        subprocess.run([sys.executable, "-m", "edge_tts", "--voice", VOICE, "--text", text, "--write-media", mp3],
                       check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["mpg123", "-q", mp3], timeout=30)
        return
    except Exception as e:
        log("edge voice failed, using espeak:", e)
    subprocess.run(["espeak-ng", "-s", "165", text], timeout=30)


def main():
    from vosk import KaldiRecognizer, Model, SetLogLevel
    SetLogLevel(-1)
    if not os.path.isdir(MODEL):
        log("no speech model in", MODEL, "- run install.sh again")
        sys.exit(1)
    model = Model(MODEL)
    words = PHRASE.lower().split()
    # only listen for our words (fast + few false alarms on an old MacBook)
    rec = KaldiRecognizer(model, RATE, json.dumps([PHRASE.lower(), "[unk]"]))
    rec.SetWords(True)
    mic = subprocess.Popen(["arecord", "-q", "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"], stdout=subprocess.PIPE)
    log(f'listening for "{PHRASE}"…')
    last = 0.0
    while True:
        data = mic.stdout.read(4000)
        if not data:
            log("microphone stopped - restarting")
            sys.exit(1)
        if not rec.AcceptWaveform(data):
            continue
        res = json.loads(rec.Result())
        got = [w for w in res.get("result", []) if w.get("word") in words]
        if len(got) < len(words) or min(w.get("conf", 0) for w in got) < 0.75:
            continue
        if time.time() - last < 4:
            continue
        log(f'heard "{PHRASE}" -> "{ANSWER}"')
        mic.kill()  # don't hear ourselves
        say(ANSWER)
        last = time.time()
        rec = KaldiRecognizer(model, RATE, json.dumps([PHRASE.lower(), "[unk]"]))
        rec.SetWords(True)
        mic = subprocess.Popen(["arecord", "-q", "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"], stdout=subprocess.PIPE)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        say(ANSWER)
    else:
        main()
