// Compatibility entry point for the UI. All page behavior lives in the shared service.
import { DocumentService } from './documents/service'
import { createAppDocumentEnvironment } from './platform/documentEnvironment'
export type { Page, PageKind, PageStatus, PageRepo, Cover } from './documents/model'
import type { Page } from './documents/model'

export class Repo extends DocumentService {
  constructor(seed: () => Page[]) {
    super(createAppDocumentEnvironment(), seed)
  }
}
