const [,, dist, dir] = process.argv;
const m = await import(dist);
const b = new m.BoardModel(dir); await b.rebuild();
const names = Object.getOwnPropertyNames(Object.getPrototypeOf(b)).filter(n=>/orkflow/.test(n));
console.log("workflow methods:", names);
let n=0; const ids=[];
for (const c of b.listCampaigns()) for (const mi of b.listMissions(c.id)) { const w = b.listWorkflows?.({missionId: mi.id}) ?? []; for (const x of w){n++; ids.push(x.id)} }
console.log("workflows seen:", n); console.log(ids.join("\n"));
