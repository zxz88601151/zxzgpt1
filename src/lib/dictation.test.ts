import { describe, expect, it } from "vitest";
import { appendTranscript, cleanTranscript, dictationErrorMessage, dictationNextStatus } from "./dictation";

describe("appendTranscript", () => {
  it("空输入框直接填转录", () => {
    expect(appendTranscript("", "你好")).toBe("你好");
  });
  it("已有文字时补空格隔开，不粘连", () => {
    expect(appendTranscript("帮我看", "这个文件")).toBe("帮我看 这个文件");
  });
  it("已有尾空格时不再补空格", () => {
    expect(appendTranscript("帮我看 ", "这个文件")).toBe("帮我看 这个文件");
  });
  it("空转录不改动原输入", () => {
    expect(appendTranscript("原文字", "   ")).toBe("原文字");
  });
});

describe("cleanTranscript", () => {
  it("空白归一：多空白压成一个空格，不改词、不擅自拼字", () => {
    expect(cleanTranscript("  帮我\n看  这个\t文件 ")).toBe("帮我 看 这个 文件");
  });
});

describe("dictationNextStatus", () => {
  it("只有 idle 才能开始录音，录音中再按开始不变", () => {
    expect(dictationNextStatus("idle", "start")).toBe("recording");
    expect(dictationNextStatus("recording", "start")).toBe("recording");
  });
  it("停止、结束、出错都回到 idle，没有卡住态", () => {
    expect(dictationNextStatus("recording", "stop")).toBe("idle");
    expect(dictationNextStatus("recording", "end")).toBe("idle");
    expect(dictationNextStatus("recording", "error")).toBe("idle");
  });
});

describe("dictationErrorMessage", () => {
  it("权限被拒时说清是浏览器设置问题", () => {
    expect(dictationErrorMessage("not-allowed")).toContain("麦克风");
  });
  it("没听到说话时说明输入框没动", () => {
    expect(dictationErrorMessage("no-speech")).toContain("没有动");
  });
  it("网络错误时明说浏览器识别要联网", () => {
    expect(dictationErrorMessage("network")).toContain("联网");
  });
});
