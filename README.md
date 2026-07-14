# Aural Chapter Desk

A fresh, send-once ChatGPT extension for generating chapter scripts. It has a small control-room UI, a shared Script Vault, and optional batch tabs.

## The safety rule

One automatic attempt means one Send click. The runner watches ChatGPT's generation state and the actual reply text; when ChatGPT has stopped and the reply is no longer changing, it saves the chapter and sends the next `go …` automatically. There are no delay, settle, or timeout controls. It scans backward for the visible `[Panel]` response, so an empty ChatGPT wrapper cannot make a finished chapter fail. If the UI ever misses a finished visible response, press **Save answer + continue**—not Retry—to save it without spending another generation.

When the runner pauses because it needs you, it plays five attention chimes. The sound stops as soon as you click **Save answer + continue**, **Retry chapter**, **Skip**, **Resume**, or start a new run. You can turn it off under **Automation options**.

When a batch run finishes, the final tab says, “All batch tabs are done. Your script is ready.” No MP3 is needed; it uses the browser’s built-in voice. You can turn this off under **Automation options**.

## Run a book

1. Load this folder through `chrome://extensions` → **Load unpacked**.
2. Refresh ChatGPT. The **Aural Chapter Desk** appears at the top-right.
3. Open **Book setup** and fill in your Master prompt, 1–5 Book links, and optional Style sample. Tick **Send Book Setup before chapter 1**. The setup message tells ChatGPT it may use any working link.
4. In **Chapter PDFs**, press **Attach PDFs + Begin** and select all PDFs for this tab. It uses ChatGPT's real file picker, then reads chapter numbers from names such as `chapter_01.pdf` or `ch_01.pdf`.
5. Set `go {n}` and the chapter range before attaching. If PDFs are already uploaded, use **Begin (PDFs attached)** instead.
6. Use the Script Vault to copy or download the collected panel scripts.

The runner tracks a clear lifecycle: `queued → typing → sent once → writing → saved` (or `needs you`). A restored run is paused safely; Resume watches a previously-sent prompt instead of sending it again.

## Batch tabs

Choose 1–12 tabs in **Folder batch automation**, then press **Choose folder + auto-batch**. Chrome asks you to choose the folder once. The extension opens the batch tabs and gives each tab only the PDF filenames that belong to its range, such as `1–10`, `11–20`, and `21–30`. To prevent ChatGPT tabs from crashing, it automatically raises the batch count when needed to keep each upload at 12 PDFs or fewer. Their saved chapters appear in the same Script Vault in numerical order.

Folder automation works in Chrome/Edge and requires filenames containing the chapter number, such as `chapter_021.pdf` or `ch_021.pdf`. The folder handle remains local to your browser; it is used only to read PDFs you selected for ChatGPT uploads.

## Existing scripts

Scripts made with the earlier Aural GPT Script version remain available in the new Script Vault. Clearing the vault clears both old and new saved chapters.
