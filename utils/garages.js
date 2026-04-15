import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

let GARAGES;
const configString = process.env.GARAGES_CONFIG;

if (configString) {
  try {
    GARAGES = JSON.parse(configString);
  } catch {
    GARAGES = JSON.parse(fs.readFileSync("./garages.json", "utf-8"));
  }
} else {
  GARAGES = JSON.parse(fs.readFileSync("./garages.json", "utf-8"));
}

export function getGarageByName(name) {
  return Object.values(GARAGES).find(g => g.name === name) || null;
}

export { GARAGES };
