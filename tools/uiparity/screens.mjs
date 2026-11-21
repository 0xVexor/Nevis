// How to reach each screen in the OLD app and in the NEW one. Old rail rows are picked by position (their labels change with the language).
const OLD_NAV = { home: 0, templates: 1, tasks: 2, cards: 3, databases: 4, drawings: 5, graph: 6, all: 7, settings: 8, files: 9, trash: 10 }
const oldNav = name => async page => { await page.locator('.row.plain:not(.search-row)').nth(OLD_NAV[name]).click() }
const newNav = id => async page => { await page.getByTestId(id).click() }
const oldPage = key => async (page, ids) => { await oldNav('home')(page); await page.locator(`[data-id="${ids[key]}"], [data-page-id="${ids[key]}"]`).first().click().catch(async () => { await page.getByText(TITLES[key]).first().click() }) }
const TITLES = { shiraz: 'سفر به شیراز', notes: 'Meeting notes' }
const newPage = key => async (page, ids) => { await page.locator(`[data-testid=page-row][data-id="${ids[key]}"]`).first().dblclick() }

export const SCREENS = {
  // Home decides "first visit" when it mounts: the new workspace was empty then, so leave the screen and come back
  home: { old: oldNav('home'), new: async page => { await page.getByTestId('nav-templates').click(); await page.getByTestId('nav-home').click() } },
  page: { old: oldPage('shiraz'), new: newPage('shiraz'), wait: 1200 },
  templates: { old: oldNav('templates'), new: newNav('nav-templates') },
  tasks: { old: oldNav('tasks'), new: newNav('nav-tasks') },
  cards: { old: oldNav('cards'), new: newNav('nav-cards') },
  graph: { old: oldNav('graph'), new: newNav('nav-graph'), wait: 2500 },
  all: { old: oldNav('all'), new: newNav('nav-all') },
  settings: { old: oldNav('settings'), new: newNav('nav-settings') },
  trash: { old: oldNav('trash'), new: newNav('trash-toggle') },
}
