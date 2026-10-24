// Accuracy check for the code-block language detector (src/editor/detect.ts).
import assert from 'node:assert/strict'

const { detectLanguage } = await import('../spike/tiptap/src/editor/detect.ts')

const S = [
  ['java', 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}'],
  ['java', 'import java.util.*;\nList<String> xs = new ArrayList<>();\nfor (String s : xs) { }'],
  ['java', '@Override\npublic String toString() { return name; }'],
  ['python', 'def f(x):\n    for i in range(10):\n        print(i)\n    return x'],
  ['python', 'import os\nclass A:\n    def __init__(self):\n        self.x = None'],
  ['python', 'if x > 3:\n    print("big")\nelse:\n    print("small")'],
  ['javascript', 'const sum = (a, b) => a + b;\nconsole.log(sum(1, 2));'],
  ['javascript', 'function add(a, b) {\n  return a === b;\n}\nmodule.exports = add;'],
  ['typescript', 'interface User { id: number; name: string }\nconst u: User = { id: 1, name: "a" };'],
  ['typescript', 'type Id = string | number;\nlet x: Id = 5;'],
  ['c', '#include <stdio.h>\nint main(void) {\n  printf("hi");\n  return 0;\n}'],
  ['cpp', '#include <iostream>\nusing namespace std;\nint main() { cout << "hi" << endl; }'],
  ['cpp', 'std::vector<int> v;\nfor (auto x : v) std::cout << x;'],
  ['csharp', 'using System;\nclass P { static void Main() { Console.WriteLine("hi"); } }'],
  ['csharp', 'public string Name { get; set; }'],
  ['go', 'package main\nimport "fmt"\nfunc main() { fmt.Println("hi") }'],
  ['rust', 'fn main() {\n    let x: i32 = 5;\n    println!("{}", x);\n}'],
  ['kotlin', 'fun main() {\n    val x = 5\n    println("x = $x")\n}'],
  ['swift', 'import Foundation\nfunc add(a: Int) -> Int {\n  return a\n}'],
  ['ruby', 'def greet(name)\n  puts "hi #{name}"\nend'],
  ['php', '<?php\necho "hi";\n$x = 5;\n?>'],
  ['sql', 'SELECT name, age FROM users WHERE age > 18 ORDER BY name;'],
  ['sql', 'CREATE TABLE t (id INT PRIMARY KEY, name TEXT);'],
  ['bash', '#!/bin/bash\nfor f in *.txt; do\n  echo "$f"\ndone'],
  ['bash', 'sudo apt install git\ncd project && npm install'],
  ['json', '{ "name": "a", "list": [1, 2, 3], "ok": true }'],
  ['xml', '<div class="a"><p>hello</p></div>'],
  ['xml', '<!DOCTYPE html>\n<html><body></body></html>'],
  ['css', '.card { color: #333; margin: 0 auto; }'],
  ['css', 'body {\n  font-family: sans-serif;\n}\n@media (max-width: 600px) { .a { display: none; } }'],
  ['yaml', 'name: app\nitems:\n  - a\n  - b'],
  ['diff', '@@ -1,2 +1,2 @@\n-old line\n+new line'],
  // must stay undetected (plain text / too short) so they are not mis-coloured
  [null, 'این یک متن عادی فارسی است و کد نیست'],
  [null, 'x = 5'],
  [null, 'hello world'],
]

let ok = 0
const bad = []
for (const [want, code] of S) {
  const got = detectLanguage(code)
  if (got === want) ok++
  else bad.push(`${want ?? 'none'} -> ${got ?? 'none'}: ${code.split('\n')[0]}`)
}
console.log(`detector: ${ok}/${S.length} correct`)
if (bad.length) console.log('misses:\n  ' + bad.join('\n  '))
assert.equal(bad.length, 0)
console.log('detect OK')
