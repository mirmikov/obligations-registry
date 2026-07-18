import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = process.argv[2];
const outputDir = process.argv[3] ?? ".audit";
if (!inputPath) throw new Error("Usage: audit-workbook.mjs <xlsx> [output-dir]");

await fs.mkdir(outputDir, { recursive: true });
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table,definedName,drawing",
  maxChars: 30000,
  tableMaxRows: 8,
  tableMaxCols: 16,
  tableMaxCellChars: 120,
});
await fs.writeFile(`${outputDir}/summary.ndjson`, summary.ndjson, "utf8");

const sheetList = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 10000 });
const parsedSheets = sheetList.ndjson
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const report = [];
for (let index = 0; index < parsedSheets.length; index += 1) {
  const row = parsedSheets[index];
  const name = row.name ?? row.sheetName ?? row.label;
  const id = row.id ?? name;
  const sheet = workbook.worksheets.getItemAt(index);
  const used = sheet.getUsedRange();
  const address = used?.address ?? null;
  const entry = { index, id, name, usedRange: address };

  try {
    const region = await workbook.inspect({
      kind: "region",
      sheetId: id,
      range: address ?? "A1:Z100",
      maxChars: 40000,
      tableMaxRows: 40,
      tableMaxCols: 40,
      tableMaxCellChars: 180,
    });
    await fs.writeFile(`${outputDir}/sheet-${index + 1}-region.ndjson`, region.ndjson, "utf8");
  } catch (error) {
    entry.regionError = String(error);
  }

  try {
    const formulas = await workbook.inspect({
      kind: "formula",
      sheetId: id,
      range: address ?? "A1:Z100",
      maxChars: 30000,
      options: { maxResults: 500 },
    });
    await fs.writeFile(`${outputDir}/sheet-${index + 1}-formulas.ndjson`, formulas.ndjson, "utf8");
  } catch (error) {
    entry.formulaError = String(error);
  }

  try {
    const styles = await workbook.inspect({
      kind: "computedStyle",
      sheetId: id,
      range: address ?? "A1:Z30",
      maxChars: 15000,
    });
    await fs.writeFile(`${outputDir}/sheet-${index + 1}-styles.ndjson`, styles.ndjson, "utf8");
  } catch (error) {
    entry.styleError = String(error);
  }

  try {
    const preview = await workbook.render({
      sheetName: name,
      autoCrop: "all",
      scale: 1,
      format: "png",
    });
    await fs.writeFile(`${outputDir}/sheet-${index + 1}.png`, new Uint8Array(await preview.arrayBuffer()));
  } catch (error) {
    entry.renderError = String(error);
  }
  report.push(entry);
}

await fs.writeFile(`${outputDir}/report.json`, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
