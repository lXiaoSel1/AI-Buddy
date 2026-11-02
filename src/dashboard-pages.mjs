const aliases=new Map([['sessions','overview'],['shop','r95-shop'],['backpack','r95-inventory'],['social','r95-social'],['galgame-reply','galgame']]);

// Native menus, CLI/hash navigation and the sidebar all share page identity.
export function normalizeDashboardPage(value){const page=typeof value==='string'?value:'';return (aliases.get(page)??page)||'overview';}
