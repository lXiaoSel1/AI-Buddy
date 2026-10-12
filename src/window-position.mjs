export function clampToDisplays(bounds,displays,primary=displays[0]) {
 const chosen=displays.find(d=>bounds.x>=d.workArea.x && bounds.x<d.workArea.x+d.workArea.width && bounds.y>=d.workArea.y && bounds.y<d.workArea.y+d.workArea.height) || primary;
 const a=chosen.workArea;
 return {...bounds,x:Math.max(a.x,Math.min(bounds.x,a.x+a.width-bounds.width)),y:Math.max(a.y,Math.min(bounds.y,a.y+a.height-bounds.height))};
}
