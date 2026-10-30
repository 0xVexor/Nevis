// Compatibility entry point for the UI. All page behavior lives in the shared service.
import { DocumentService } from './documents/service'
import { createAppDocumentEnvironment } from './platform/documentEnvironment'
export type { Page, PageKind, PageStatus, PageRepo, Cover } from './documents/model'
import type { Page } from './documents/model'

export class Repo extends DocumentService {
  constructor(seed: () => Page[]) { super(createAppDocumentEnvironment(), seed) }
}

export const WELCOME_DOC = `
<h1>یادداشت درس جاوا</h1>
<p>متغیر <code>count</code> را از نوع int تعریف کنید و مقدار 10 بدهید.</p>
<p>This is an English paragraph with فارسی in the middle و عدد 123.</p>
<p>برای شروع، در یک خط جدید <code>/</code> بزنید تا منوی بلاک‌ها باز شود.</p>
<ul><li>مورد اول</li><li>Second item</li><li>مورد سوم با English</li></ul>
<table dir="rtl"><tbody>
<tr><th>مفهوم</th><th>Concept</th><th>توضیح</th></tr>
<tr><td>کلاس</td><td>Class</td><td>قالب ساخت شیء</td></tr>
<tr><td>شیء</td><td>Object</td><td>نمونه‌ای از کلاس</td></tr>
</tbody></table>
<pre><code class="language-java">public class Main {
  public static void main(String[] args) {
    System.out.println("سلام دنیا");
  }
}</code></pre>
`
