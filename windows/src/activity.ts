// Whimsical activity vocabulary , a 1:1 port of the macOS app's
// ClaudeActivityFormatter (5 themes, per-tool phrase pools, file-type hints,
// rotating pick per key). The Simplified Chinese UI uses its own phrase pools
// so live pet bubbles do not unexpectedly fall back to English.

import { getLang, t } from "./i18n";

export type ActivityThemeName = "chef" | "engineer" | "wizard" | "explorer" | "scientist";

interface ThemePools {
  reading: string[];
  writing: string[];
  running: string[];
  searching: string[];
  delegating: string[];
  thinking: string[];
  done: string[];
  waiting: string[];
  skill: string[];
  generic: string[];
}

export const ACTIVITY_THEMES: Record<ActivityThemeName, ThemePools> = {
  chef: {
    reading: ["Perusing…", "Leafing through…", "Absorbing…", "Studying…", "Browsing…"],
    writing: ["Cooking…", "Baking…", "Crafting…", "Whittling…", "Sculpting…", "Stitching…"],
    running: ["Brewing…", "Simmering…", "Stirring the pot…", "Running the numbers…"],
    searching: ["Foraging…", "Scouting…", "Hunting…", "Exploring…", "Investigating…"],
    delegating: ["Delegating…", "Hatching a plan…", "Spawning help…", "Rounding up agents…"],
    thinking: ["Photosynthesizing…", "Sprouting…", "Planning…", "Pondering…", "Germinating…", "Marinating…", "Noodling…"],
    done: ["All done!", "Wrapped up!", "Delivered!", "Finished!", "Mission complete!"],
    waiting: ["Awaiting instructions…", "Standing by…", "Listening…"],
    skill: ["Consulting the recipe…", "Checking the cookbook…", "Following the method…"],
    generic: ["Working…", "Tinkering…", "Doing the thing…"],
  },
  engineer: {
    reading: ["Inspecting…", "Reviewing…", "Parsing…", "Auditing…", "Loading…"],
    writing: ["Refactoring…", "Implementing…", "Patching…", "Scaffolding…", "Committing…"],
    running: ["Compiling…", "Building…", "Executing…", "Deploying…", "Running the pipeline…"],
    searching: ["Scanning…", "Grepping…", "Indexing…", "Tracing…", "Profiling…"],
    delegating: ["Spawning a process…", "Forking…", "Dispatching…", "Queueing a job…"],
    thinking: ["Architecting…", "Designing…", "Calculating…", "Debugging…", "Optimizing…"],
    done: ["Build complete!", "Shipped!", "Merged!", "All green!", "Tests passing!"],
    waiting: ["Awaiting input…", "Blocked on dependency…", "Polling…"],
    skill: ["Reading the manual…", "Checking the docs…", "Loading the module…"],
    generic: ["Processing…", "Running…", "Executing…"],
  },
  wizard: {
    reading: ["Studying the scrolls…", "Deciphering…", "Consulting the tome…", "Peering within…"],
    writing: ["Inscribing…", "Enchanting…", "Weaving a spell…", "Scribing…"],
    running: ["Casting…", "Invoking…", "Summoning…", "Channeling magic…"],
    searching: ["Divining…", "Scrying…", "Seeking…", "Gazing into the orb…"],
    delegating: ["Calling forth…", "Summoning a familiar…", "Conjuring help…"],
    thinking: ["Meditating…", "Pondering the arcane…", "Consulting the stars…", "Prophesying…"],
    done: ["The spell is cast!", "It is done!", "Magic complete!", "Quest fulfilled!"],
    waiting: ["Awaiting the omens…", "The stars are aligning…", "Patience, young apprentice…"],
    skill: ["Consulting the scrolls…", "Channeling a skill…", "Reading the grimoire…"],
    generic: ["Weaving…", "Working the magic…", "At work…"],
  },
  explorer: {
    reading: ["Surveying…", "Mapping the terrain…", "Examining the site…", "Charting…"],
    writing: ["Logging the expedition…", "Marking the map…", "Recording findings…", "Documenting…"],
    running: ["Blazing a trail…", "Trekking…", "Venturing forth…", "Pushing on…"],
    searching: ["Scouting ahead…", "Seeking passage…", "Exploring…", "Reconnoitering…"],
    delegating: ["Sending a scout…", "Dispatching a guide…", "Rallying the crew…"],
    thinking: ["Plotting a course…", "Reading the stars…", "Studying the map…", "Planning the route…"],
    done: ["Base camp reached!", "Trail blazed!", "Discovery made!", "Expedition complete!"],
    waiting: ["Awaiting the tide…", "Resting at camp…", "Holding position…"],
    skill: ["Consulting the guide…", "Reading the field notes…", "Checking the compass…"],
    generic: ["Moving forward…", "Pressing on…", "On the trail…"],
  },
  scientist: {
    reading: ["Observing…", "Reviewing the data…", "Analyzing the sample…", "Examining…"],
    writing: ["Synthesizing…", "Documenting findings…", "Writing the report…", "Formulating…"],
    running: ["Running the experiment…", "Executing the protocol…", "Testing the hypothesis…", "Processing…"],
    searching: ["Scanning the dataset…", "Cross-referencing…", "Searching for patterns…", "Correlating…"],
    delegating: ["Assigning to the lab…", "Tasking the team…", "Delegating to an assistant…"],
    thinking: ["Hypothesizing…", "Theorizing…", "Modeling…", "Calculating…", "Reasoning…"],
    done: ["Hypothesis confirmed!", "Results in!", "Experiment complete!", "Published!"],
    waiting: ["Awaiting results…", "Incubating…", "Waiting for the reaction…"],
    skill: ["Consulting the protocol…", "Reviewing the literature…", "Checking the procedure…"],
    generic: ["Analyzing…", "Processing…", "At work…"],
  },
};

const ZH_ACTIVITY_THEMES: Record<ActivityThemeName, ThemePools> = {
  chef: {
    reading: ["翻阅中…", "仔细阅读中…"],
    writing: ["烹饪代码中…", "精心制作中…"],
    running: ["慢火运行中…", "搅拌数据中…"],
    searching: ["搜寻中…", "四处探索中…"],
    delegating: ["分派任务中…", "召集帮手中…"],
    thinking: ["酝酿思路中…", "仔细琢磨中…"],
    done: ["全部完成！", "已经做好啦！"],
    waiting: ["等待你的指示…", "随时待命…"],
    skill: ["查看配方中…", "照着方法处理中…"],
    generic: ["工作中…", "捣鼓中…"],
  },
  engineer: {
    reading: ["检查中…", "审阅中…"],
    writing: ["重构中…", "实现功能中…"],
    running: ["编译中…", "构建中…"],
    searching: ["扫描中…", "追踪问题中…"],
    delegating: ["启动子任务中…", "派发任务中…"],
    thinking: ["设计架构中…", "调试思路中…"],
    done: ["构建完成！", "测试全部通过！"],
    waiting: ["等待输入…", "正在等待依赖…"],
    skill: ["查阅手册中…", "查看文档中…"],
    generic: ["处理中…", "执行中…"],
  },
  wizard: {
    reading: ["研读卷轴中…", "解读中…"],
    writing: ["铭刻代码中…", "编织法术中…"],
    running: ["施法中…", "召唤中…"],
    searching: ["占卜中…", "寻找线索中…"],
    delegating: ["召唤助手中…", "呼唤伙伴中…"],
    thinking: ["冥想中…", "推演奥秘中…"],
    done: ["法术完成！", "任务达成！"],
    waiting: ["等待征兆…", "星辰正在归位…"],
    skill: ["查阅卷轴中…", "调用技能中…"],
    generic: ["施展魔法中…", "忙碌中…"],
  },
  explorer: {
    reading: ["勘察中…", "绘制地图中…"],
    writing: ["记录发现中…", "整理探险日志中…"],
    running: ["开辟路线中…", "继续前进中…"],
    searching: ["向前侦察中…", "探索中…"],
    delegating: ["派出侦察员中…", "召集团队中…"],
    thinking: ["规划路线中…", "研究地图中…"],
    done: ["抵达营地！", "探索完成！"],
    waiting: ["在营地休整…", "原地待命中…"],
    skill: ["查阅指南中…", "检查指南针中…"],
    generic: ["继续探索中…", "在路上…"],
  },
  scientist: {
    reading: ["观察中…", "分析样本中…"],
    writing: ["汇总结果中…", "撰写报告中…"],
    running: ["运行实验中…", "检验假设中…"],
    searching: ["扫描数据中…", "寻找规律中…"],
    delegating: ["分配实验任务中…", "安排助手中…"],
    thinking: ["提出假设中…", "建立模型中…"],
    done: ["假设已验证！", "实验完成！"],
    waiting: ["等待结果…", "反应进行中…"],
    skill: ["查阅实验流程中…", "检查操作步骤中…"],
    generic: ["分析中…", "处理中…"],
  },
};

export const THEME_EMOJI: Record<ActivityThemeName, string> = {
  chef: "👨‍🍳", engineer: "⚙️", wizard: "🧙", explorer: "🧭", scientist: "🔬",
};

export function currentTheme(): ThemePools {
  const name = (localStorage.getItem("ap_theme_phrases") || "chef") as ActivityThemeName;
  const themes = getLang() === "zh" ? ZH_ACTIVITY_THEMES : ACTIVITY_THEMES;
  return themes[name] ?? themes.chef;
}

// Rotating pick per key, like the macOS formatter's callCounts.
const callCounts = new Map<string, number>();
function pick(phrases: string[], key: string): string {
  if (!phrases.length) return t("Working…");
  const n = ((callCounts.get(key) ?? 0) + 1) % phrases.length;
  callCounts.set(key, n);
  return phrases[n];
}

/// File-type hints that beat the generic tool pools (port of extensionHint).
function extensionHint(tool: string, filePath: string | undefined): string | null {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  const isTest = lower.includes("tests/") || lower.endsWith("tests.swift") || lower.endsWith("test.swift")
    || lower.includes("__tests__") || /\.(test|spec)\.[jt]sx?$/.test(lower);
  const isDoc = lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".rst");
  const isCfg = lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")
    || lower.endsWith(".plist") || lower.endsWith(".toml");
  const isRead = tool === "Read";
  const isWrite = tool === "Edit" || tool === "Write" || tool === "MultiEdit";
  if (isTest && isRead) return t("Reviewing tests…");
  if (isTest && isWrite) return t("Refining tests…");
  if (isDoc && isRead) return t("Reading the docs…");
  if (isDoc && isWrite) return t("Updating the docs…");
  if (isCfg && isRead) return t("Parsing config…");
  if (isCfg && isWrite) return t("Adjusting config…");
  return null;
}

function toolActivity(tool: string, filePath?: string): string | null {
  if (!tool) return null;
  const hint = extensionHint(tool, filePath);
  if (hint) return hint;
  const t = currentTheme();
  let pool: string[];
  switch (tool) {
    case "Read": pool = t.reading; break;
    case "Edit": case "Write": case "MultiEdit": pool = t.writing; break;
    case "Bash": pool = t.running; break;
    case "Glob": case "Grep": case "WebSearch": case "WebFetch": pool = t.searching; break;
    case "Agent": case "Task": pool = t.delegating; break;
    case "Skill": pool = t.skill; break;
    default: pool = t.generic;
  }
  return pick(pool, tool);
}

/// Live activity line from a hook event (port of activityMessage).
export function activityMessage(
  event: string, tool: string, filePath: string | undefined, explicit: string | undefined,
): string | null {
  const trimmed = explicit?.trim() || null;
  if (event === "Notification") return trimmed;
  if (event === "UserPromptSubmit") return pick(currentTheme().thinking, event);
  if (event === "PreToolUse" || event === "PostToolUse") return toolActivity(tool, filePath);
  if (tool) return toolActivity(tool, filePath);
  return trimmed;
}

/// Themed fallback for a state with no live activity (port of stateMessage).
export function stateMessage(state: string): string | null {
  const t = currentTheme();
  if (state === "done") return pick(t.done, "state.done");
  if (state === "waiting") return pick(t.waiting, "state.waiting");
  return null;
}

// ---- Built-in bubble message pools (port of PetChat / IdleBoost / defaults) --

export const PET_CHAT: Record<string, string[]> = {
  working: [
    "Thinking…", "Working on it…", "On it!", "Crunching code…",
    "Hmm, let me see…", "Cooking something up…", "Deep in thought…",
    "Brain go brrr…", "Almost there…", "Wiring it up…",
  ],
  waiting: ["Waiting for your input", "Your turn — over to you", "Needs your input"],
  done: [
    "All done! ✅", "Finished!", "Ta-da!", "Done and dusted!",
    "Nailed it!", "That's a wrap!", "Mission complete!",
  ],
  celebrate: ["🎉 Woohoo!", "We did it!", "Victory!", "Yesss!", "High five! 🙌", "Champion!"],
};

export const IDLE_BOOST = [
  "Let's grill some bugs.",
  "I miss you. Open a branch for me.",
  "Tiny commit, tiny dopamine.",
  "The build is quiet. Too quiet.",
  "Ship something small. Future you is watching.",
  "Your TODOs are pretending not to see us.",
  "No agents running. The keyboard has entered standby drama.",
  "Turn coffee into code. Carefully.",
  "Open one file. Intimidate it professionally.",
  "The repo is calm. Suspicious, but calm.",
  "Refactor lightly. Leave with dignity.",
  "One clean diff can fix the whole afternoon.",
];

const ZH_PET_CHAT: Record<string, string[]> = {
  working: ["思考中…", "正在处理…", "马上开始！", "整理代码中…", "让我看看…", "快完成了…"],
  waiting: ["等待你的输入", "轮到你啦", "需要你的输入"],
  done: ["全部完成！✅", "完成啦！", "大功告成！", "任务完成！"],
  celebrate: ["🎉 太棒了！", "我们做到了！", "胜利！", "击个掌！🙌"],
};

const ZH_IDLE_BOOST = [
  "来抓几个 bug 吧。",
  "想你了，开个分支陪我吧。",
  "小小提交，也有小小成就感。",
  "构建太安静了，有点可疑。",
  "先发布一个小改动吧。",
  "待办事项正在假装没看见我们。",
  "没有智能体在运行，键盘进入待机模式。",
  "把咖啡变成代码吧，小心操作。",
  "打开一个文件，专业地震慑它。",
  "仓库很平静，平静得可疑。",
  "轻轻重构，然后体面离场。",
  "一个干净的改动就能拯救整个下午。",
];

export function petChatLines(mood: string): string[] {
  const chat = getLang() === "zh" ? ZH_PET_CHAT : PET_CHAT;
  return chat[mood] ?? [];
}

/// Default editable lines per mood (port of BubbleMessages.defaultLines).
export function defaultLines(mood: string): string[] {
  switch (mood) {
    case "waiting": return petChatLines("waiting");
    case "done": return petChatLines("done");
    case "celebrate": return petChatLines("celebrate");
    case "idle": return getLang() === "zh" ? ZH_IDLE_BOOST : IDLE_BOOST;
    default: return []; // working: blank = live activity wins
  }
}

/// Effective custom/system lines for (agent kind, mood) , port of
/// BubbleMessages.lines. Keys: ap_msg_src, ap_msg_<agent|all>_<mood>.
export function bubbleLines(kind: string | null, mood: string): string[] {
  if ((localStorage.getItem("ap_msg_src") || "system") === "system") return defaultLines(mood);
  const read = (key: string): string[] | null => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines : null;
  };
  if (kind) { const v = read(`ap_msg_${kind}_${mood}`); if (v) return v; }
  const all = read(`ap_msg_all_${mood}`);
  return all ?? defaultLines(mood);
}

/// A stable line seeded by session id (djb2), like the macOS app.
export function bubbleLine(kind: string | null, mood: string, seed: string): string {
  const pool = bubbleLines(kind, mood);
  if (!pool.length) return "";
  let h = 5381;
  for (const c of seed) h = (Math.imul(h, 33) + c.charCodeAt(0)) | 0;
  return pool[Math.abs(h) % pool.length];
}

