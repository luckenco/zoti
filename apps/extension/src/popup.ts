import { ApiFailureBody, IngestResponse } from "@herodotus/schema"
import { Effect, Schema } from "effect"
import { buildCapture } from "./capture"

const statusNode = document.querySelector("#status")
const saveButton = document.querySelector("#save")
const tagsInput = document.querySelector("#tags")

const setStatus = (text: string) => {
  if (statusNode) statusNode.textContent = text
}

const tagsFromInput = (): ReadonlyArray<string> => {
  if (!(tagsInput instanceof HTMLInputElement)) return []
  return tagsInput.value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

const readSettings = Effect.tryPromise({
  try: () => chrome.storage.local.get(["workerUrl", "token"]),
  catch: () => new Error("storage"),
})

const activeTab = Effect.tryPromise({
  try: () => chrome.tabs.query({ active: true, currentWindow: true }),
  catch: () => new Error("tabs"),
})

const readPage = (tabId: number) =>
  Effect.tryPromise({
    try: () =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content") ?? ""
          return {
            selection: window.getSelection()?.toString() ?? "",
            ogTitle: meta('meta[property="og:title"]'),
            author: meta('meta[name="author"]'),
            published: meta('meta[property="article:published_time"]'),
          }
        },
      }),
    catch: () => new Error("scripting"),
  })

const postCapture = (workerUrl: string, token: string, body: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL("/v1/records", workerUrl.endsWith("/") ? workerUrl : `${workerUrl}/`), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, text }
    },
    catch: () => new Error("network"),
  })

// Retain the exact capture after a failure so retries reuse its id and timestamp.
let pending: Effect.Effect.Success<ReturnType<typeof buildCapture>> | undefined

const save = Effect.gen(function* () {
  const settings = yield* readSettings
  const workerUrl = settings.workerUrl
  const token = settings.token
  if (typeof workerUrl !== "string" || workerUrl.length === 0 || typeof token !== "string" || token.length === 0) {
    return "Open the extension options and set the worker URL and token."
  }
  if (pending === undefined) {
    const tabs = yield* activeTab
    const tab = tabs[0]
    if (tab?.id === undefined || typeof tab.url !== "string" || tab.url.length === 0) {
      return "This tab has no URL to save."
    }
    const results = yield* readPage(tab.id)
    pending = yield* buildCapture({
      id: crypto.randomUUID(),
      pageUrl: tab.url,
      title: tab.title ?? "",
      selection: results[0]?.result?.selection ?? "",
      ogTitle: results[0]?.result?.ogTitle ?? "",
      author: results[0]?.result?.author ?? "",
      published: results[0]?.result?.published ?? "",
      tags: tagsFromInput(),
      ts: new Date().toISOString(),
    }).pipe(Effect.mapError(() => new Error("capture")))
  }
  const response = yield* postCapture(workerUrl, token, pending)
  const json = yield* Effect.try({
    try: (): unknown => JSON.parse(response.text),
    catch: () => new Error("response"),
  })
  if (response.status === 201) {
    const accepted = yield* Schema.decodeUnknown(IngestResponse)(json).pipe(Effect.mapError(() => new Error("response")))
    const id = accepted.ids[0]
    pending = undefined
    return id === undefined ? "Saved." : `Saved ${id}.`
  }
  const failure = yield* Schema.decodeUnknown(ApiFailureBody)(json).pipe(Effect.orElseSucceed(() => undefined))
  return failure === undefined ? `Save failed (${response.status}).` : `Save failed: ${failure._tag}.`
})

saveButton?.addEventListener("click", () => {
  if (!(saveButton instanceof HTMLButtonElement) || saveButton.disabled) return
  saveButton.disabled = true
  setStatus("Saving.")
  void Effect.runPromise(
    save.pipe(
      Effect.match({
        onFailure: () => "Save failed.",
        onSuccess: (message) => message,
      }),
    ),
  ).then(setStatus).finally(() => {
    saveButton.disabled = false
    saveButton.textContent = "Save"
    if (pending !== undefined) saveButton.textContent = "Retry save"
  })
})
