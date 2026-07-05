# Aural GPT Script

A browser extension for chatgpt.com that runs your whole book automatically:
sends "go 1" → waits for the chapter script → sends "go 2" → … and harvests
every chapter's `[Panel ...]` lines into one ordered book script you copy
with a single click.

Works in **Chrome, AVG Secure Browser, Opera, Edge, Brave** (any Chromium browser).

## Download

Grab `aural-gpt-script.zip` from the
[latest release](https://github.com/thetuffone67/aural-gpt-script/releases/latest)
and unzip it, then follow the install steps below.

## Install (load unpacked)

1. Open the extensions page: `chrome://extensions` (Opera: `opera://extensions`)
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Open or refresh https://chatgpt.com — the **⚡ Aural GPT Script** panel
   appears bottom-right.

## One-time book setup

Open **📖 Book setup** in the panel and paste, once:
- **Master prompt** — your full recap-script prompt
- **Book link** — the MangaFire (or other provider) link
- **Style sample** — the example script showing the target sound

All three are saved permanently. The composed setup message is:
master prompt + `Book link for story context: <link>` + `STYLE SAMPLE: <sample>`.

## Single-tab run

1. In the ChatGPT conversation, upload the chapter PDFs (or use Begin below).
2. Tick **Send Book setup as first message on Start** if the setup wasn't sent yet.
3. Template `go {n}`, range e.g. **1 to 20**, press **▶ Start**.
4. It sends the setup, then go 1, go 2, … each one the moment the previous
   chapter finishes.

## Parallel run (2–4 tabs — this is the real speedup)

1. Set the full range (e.g. 1 to 50), pick **3 tabs**, click **🗂 Open batch tabs**.
2. The range splits automatically (tab 1: 1–17, tab 2: 18–34, tab 3: 35–50).
   Each new tab shows a blue banner with its assigned chapters.
3. In each tab click **📎 Attach PDFs + Begin** and select either:
   - **all 50 PDFs** — the tab picks its own chapters by filename order, or
   - **exactly that tab's PDFs** — used as-is.
   The PDFs are injected into ChatGPT, the setup message sends itself when
   uploads finish, and the chapter queue starts.
4. Chapters from all tabs land in the same book, in the right order.

If file injection ever breaks (ChatGPT UI change), drag the PDFs into the chat
manually and press **Begin (PDFs already uploaded)** instead.

Tip: PDFs must sort correctly by name — zero-pad them (`ch01.pdf` … `ch50.pdf`),
otherwise `ch10` sorts before `ch2`.

## Harvesting and the book script

With **Harvest** on (default), when a chapter finishes the extension:
1. Takes the response and cuts everything before the first `[Panel 001]` —
   the Chapter/count/characters header is dropped.
2. Validates it: panels exist, and the `Chapter:` header matches the chapter
   that was asked for. On failure it pauses and beeps — **Resume** retries the
   chapter, **Skip** moves on.
3. Saves it under its chapter number. Re-running a chapter overwrites the old
   version, so "redo chapter 7" is just running go 7 again.

The **Book script** section shows progress (`Saved: 34 chapters (1–34) ·
missing: 12`) and has:
- **📋 Copy full script** — the entire book on your clipboard: chapter panels
  in order, one blank line between chapters, no headers, numbering restarting
  at `[Panel 001]` each chapter.
- **💾 Download** — same thing as `book-script.txt`.
- **🗑 Clear** — wipe the saved book (asks first). Reset does NOT clear the book.

Chapters are stored in extension storage, shared across tabs and surviving
restarts.

## Settings

| Setting | Meaning |
|---|---|
| Delay (s) | Wait after a response finishes before the next prompt (default 3). |
| Settle (s) | Generation must stay stopped this long to count as done. Raise to 10–15 if ChatGPT pauses mid-answer and the runner moves on too early. |
| Max (min) | Pause the queue if one chapter takes longer than this. |

## Notes

- ChatGPT limits uploads per conversation (~10 per message / ~20 per chat on
  most plans) — the 2–3 tab split keeps each conversation under it. For a
  50-chapter book, prefer 3–4 tabs.
- Generation speed itself is OpenAI's — the extension removes all idle time
  and parallelizes; it can't make one chapter generate faster.
- If ChatGPT changes its UI, the selectors at the top of `content.js` are the
  only thing that needs updating.
