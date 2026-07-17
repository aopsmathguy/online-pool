// src/table.js — pure table geometry (point generators only, no Three / no Ammo).
// Shared by the server (to build rail/pocket physics) and the client (to build
// the visual rail/felt meshes), so it must stay free of Three/Ammo imports.
import { mid_mouth, mid_throat, corner_mouth, corner_throat, inset } from './constants.js';

export function rail_pts(tableW, tableH) {
  const reflectX = ([x, y]) => [ x, -y];
  const reflectY = ([x, y]) => [-x,  y];
  const SQRT2 = Math.SQRT2;

  const TL_CORNER = [
    [-tableW*0.5,                          -tableH*0.5 + corner_mouth/SQRT2],
    [-tableW*0.5 - inset,                  -tableH*0.5 - inset + corner_throat/SQRT2],
    [-tableW*0.5 - inset - 0.025,          -tableH*0.5 - inset + 0.055],
    [-tableW*0.5 - inset - 0.025,          -tableH*0.5 - inset],
    [-tableW*0.5 - inset,                  -tableH*0.5 - inset - 0.025],
    [-tableW*0.5 - inset + 0.055,          -tableH*0.5 - inset - 0.025],
    [-tableW*0.5 - inset + corner_throat/SQRT2, -tableH*0.5 - inset],
    [-tableW*0.5 + corner_mouth/SQRT2,     -tableH*0.5],
  ];

  const TOP_MID = [
    [-mid_mouth/2, -tableH*0.5],
    [-mid_throat/2, -tableH*0.5 - inset],
    [-0.035, -tableH*0.5 - inset - 0.035],
    [0, -tableH*0.5 - inset - 0.05],
    [0.035, -tableH*0.5 - inset - 0.035],
    [mid_throat/2, -tableH*0.5 - inset],
    [mid_mouth/2, -tableH*0.5],
  ];

  const TOP = [...TL_CORNER, ...TOP_MID, ...TL_CORNER.map(reflectY).reverse()];
  const BOTTOM = TOP.slice().reverse().map(reflectX);
  const pts = [...TOP, ...BOTTOM];
  pts.push(pts[0]);
  return pts;
}

export function felt_pts(tableW, tableH) {
  const reflectX = ([x, y]) => [ x, -y];
  const reflectY = ([x, y]) => [-x,  y];

  const TL_FELT = [
    [-tableW * 0.5 - inset,              -tableH * 0.5 - inset + 0.095],
    [-tableW * 0.5 - inset + 0.05,       -tableH * 0.5 - inset + 0.095],
    [-tableW * 0.5 - inset + 0.079,      -tableH * 0.5 - inset + 0.079],
    [-tableW * 0.5 - inset + 0.095,      -tableH * 0.5 - inset + 0.05],
    [-tableW * 0.5 - inset + 0.095,      -tableH * 0.5 - inset],
  ];
  const TOP_MID = [
    [-0.051, -tableH * 0.5 - inset],
    [-0.048, -tableH * 0.5 - inset + 0.015],
    [-0.031, -tableH * 0.5 - inset + 0.031],
    [0.0,    -tableH * 0.5 - inset + 0.04],
    [0.031,  -tableH * 0.5 - inset + 0.031],
    [0.048,  -tableH * 0.5 - inset + 0.015],
    [0.051,  -tableH * 0.5 - inset],
  ];
  const TR_FELT = TL_FELT.map(reflectY).reverse();
  const TOP = [...TL_FELT, ...TOP_MID, ...TR_FELT];
  const BOTTOM = TOP.slice().reverse().map(reflectX);
  const pts = [...TOP, ...BOTTOM];
  pts.push(pts[0]);
  return pts;
}

export function pocket_positions(tableW, tableH){
  return [
    [-tableW/2 - 0.015, -tableH/2 - 0.015],
    [0, -tableH/2 - 0.05],
    [tableW/2 + 0.015, -tableH/2 - 0.015],
    [tableW/2 + 0.015, tableH/2 + 0.015],
    [0, tableH/2 + 0.05],
    [-tableW/2 - 0.015, tableH/2 + 0.015],
  ];
}
