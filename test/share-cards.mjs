import { renderShareCard, challengeLink } from "../src/challenge-share.js";
const models = [
  {
    name: "今天也要合出最大一只Clawd的橙色钳子朋友".repeat(3),
    score: 10000000,
    maxLevel: 11,
    status: "正式 · 已提交",
  },
  { name: "橙色钳子", score: 0, maxLevel: 1, status: "正式 · 待提交" },
  { name: "练习玩家", score: 5739, maxLevel: 9, status: "练习 · 不参与排名" },
].map((v) => {
  const m = {
    ...v,
    challengeId: "2026-10-02",
    rulesVersion: "daily-1",
    drops: 100,
  };
  return { ...m, url: challengeLink(m) };
});
const output = [];
try {
  for (const model of models) {
    const { canvas, blob } = await renderShareCard(model);
    if (
      blob.type !== "image/png" ||
      blob.size === 0 ||
      canvas.width !== 900 ||
      canvas.height !== 1200
    )
      throw new Error("Invalid PNG");
    const section = document.createElement("section"),
      title = document.createElement("h2"),
      a = document.createElement("a");
    title.textContent = model.status;
    a.href = URL.createObjectURL(blob);
    a.download = `sample-${model.score}.png`;
    a.textContent = "下载 PNG";
    section.append(title, canvas, a);
    document.querySelector("#cards").append(section);
    const decoded = await createImageBitmap(blob);
    if (decoded.width !== 900 || decoded.height !== 1200)
      throw new Error("PNG decode failed");
    decoded.close();
    output.push(`${model.status}: 900×1200 PNG，${blob.size} bytes，解码通过`);
  }
  document.querySelector("#status").textContent = `PASS\n${output.join("\n")}`;
} catch (e) {
  document.querySelector("#status").textContent = `FAIL: ${e.message}`;
  throw e;
}
