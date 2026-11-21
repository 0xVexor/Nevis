// Image covers are attachments: the workspace gives this module the way to store and to read them (set by WorkspaceView).
export interface CoverFiles { put: (file: File) => Promise<string>; url: (id: string) => Promise<string | null> }
let files: CoverFiles | null = null
export const setCoverFiles = (f: CoverFiles | null) => { files = f }
export const putFile = (file: File): Promise<string> => (files ? files.put(file) : Promise.reject(new Error('attachments are not available')))
export const urlFor = (id: string): Promise<string | null> => (files ? files.url(id) : Promise.resolve(null))
/** The system file picker for images. */
export function pickFiles(accept: string): Promise<File[]> {
  return new Promise(ok => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = accept; input.style.display = 'none'
    input.onchange = () => { const f = [...(input.files ?? [])]; input.remove(); ok(f) }
    input.oncancel = () => { input.remove(); ok([]) }
    document.body.append(input); input.click()
  })
}
