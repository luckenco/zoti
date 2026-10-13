const statusNode = document.querySelector("#status")
const form = document.querySelector("#settings")
const urlInput = document.querySelector("#workerUrl")
const tokenInput = document.querySelector("#token")

const setStatus = (text: string) => {
  if (statusNode) statusNode.textContent = text
}

const load = async () => {
  const stored = await chrome.storage.local.get(["workerUrl", "token"])
  if (urlInput instanceof HTMLInputElement && typeof stored.workerUrl === "string") {
    urlInput.value = stored.workerUrl
  }
  if (tokenInput instanceof HTMLInputElement && typeof stored.token === "string") {
    tokenInput.value = stored.token
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault()
  if (!(urlInput instanceof HTMLInputElement) || !(tokenInput instanceof HTMLInputElement)) return
  const workerUrl = urlInput.value.trim()
  const token = tokenInput.value.trim()
  if (workerUrl.length === 0 || token.length === 0) {
    setStatus("Both fields are required.")
    return
  }
  void chrome.storage.local.set({ workerUrl, token }).then(() => {
    setStatus("Saved in this browser.")
  })
})

void load()
