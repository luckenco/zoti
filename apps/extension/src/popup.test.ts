import assert from "node:assert/strict"
import { beforeEach, afterEach, describe, it, vi } from "vitest"

class Button extends EventTarget {
  disabled = false
  textContent = "Save"

  click() {
    this.dispatchEvent(new Event("click"))
  }
}

let button = new Button()
const status = { textContent: "" }
const fetchMock = vi.fn<typeof fetch>()
const tabs = vi.fn(async () => [{ id: 1, url: "https://example.com/post", title: "A post" }])

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  button = new Button()
  status.textContent = ""
  vi.stubGlobal("HTMLButtonElement", Button)
  vi.stubGlobal("HTMLInputElement", class {})
  vi.stubGlobal("document", {
    querySelector: (selector: string) => {
      if (selector === "#save") return button
      if (selector === "#status") return status
      return null
    },
  })
  vi.stubGlobal("chrome", {
    storage: { local: { get: async () => ({ workerUrl: "https://worker.example", token: "test-token" }) } },
    tabs: { query: tabs },
    scripting: { executeScript: async () => [{ result: { selection: "a passage", ogTitle: "", author: "", published: "" } }] },
  })
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [body.records[0].id] }), { status: 201 })
  })
  vi.stubGlobal("fetch", fetchMock)
  await import("./popup")
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("popup save", () => {
  it("ignores overlapping clicks and unlocks after success", async () => {
    const save = button
    let finish: ((response: Response) => void) | undefined
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    save.click()
    assert.equal(save.disabled, true)
    await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 1))
    save.click()
    assert.equal(fetchMock.mock.calls.length, 1)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    assert.match(body.records[0].id, /^[0-9a-f-]{36}$/)
    assert.ok(finish)
    finish(new Response(JSON.stringify({ schemaVersion: 1, inserted: 1, ids: [body.records[0].id] }), { status: 201 }))
    await vi.waitFor(() => assert.equal(save.disabled, false))
    assert.equal(status.textContent, `Saved ${body.records[0].id}.`)
    assert.equal(save.textContent, "Save")
  })

  it("retries the exact capture after failure and creates a new id only after success", async () => {
    const save = button
    fetchMock.mockRejectedValueOnce(new Error("connection lost after insert"))
    save.click()
    await vi.waitFor(() => assert.equal(save.disabled, false))
    assert.equal(status.textContent, "Save failed.")
    assert.equal(save.textContent, "Retry save")
    const original = fetchMock.mock.calls[0]?.[1]?.body
    assert.equal(typeof original, "string")
    save.click()
    await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 2))
    await vi.waitFor(() => assert.equal(save.disabled, false))
    assert.equal(fetchMock.mock.calls[1]?.[1]?.body, original)
    assert.equal(tabs.mock.calls.length, 1)
    assert.equal(save.textContent, "Save")
    save.click()
    await vi.waitFor(() => assert.equal(fetchMock.mock.calls.length, 3))
    await vi.waitFor(() => assert.equal(save.disabled, false))
    const next = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))
    assert.notEqual(next.records[0].id, JSON.parse(String(original)).records[0].id)
    assert.equal(tabs.mock.calls.length, 2)
  })
})
