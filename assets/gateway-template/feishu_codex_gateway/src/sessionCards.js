import fs from "node:fs";
import path from "node:path";

export function loadDesktopWorkspaceRoots() {
  const globalStatePath = path.join(process.env.USERPROFILE || "", ".codex", ".codex-global-state.json");
  try {
    const state = JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
    return (state["electron-saved-workspace-roots"] || []).map(normalizePath);
  } catch {
    return [];
  }
}

export function buildProjectSessionCards({ threads, currentChat, savedRoots }) {
  const visibleThreads = threads.filter(shouldShowThread);
  const { projectGroups, normalThreads } = groupThreads(visibleThreads, savedRoots);
  const currentRoot = matchingProjectRoot(currentChat?.cwd, savedRoots);
  const currentProject = currentRoot ? projectLabel(path.basename(currentRoot)) : "普通会话";
  const currentThreadName = currentChat?.threadName || "Feishu Session";
  const orderedProjects = [...projectGroups.keys()].sort((a, b) => {
    if (a === currentProject) return -1;
    if (b === currentProject) return 1;
    return a.localeCompare(b, "zh-Hans-CN");
  });

  const cardKitCard = buildCardKit2({
    currentProject,
    currentThreadName,
    orderedProjects,
    projectGroups,
    normalThreads,
    currentThreadId: currentChat?.threadId || ""
  });

  const fallbackCard = buildFallbackCard({
    currentProject,
    currentThreadName,
    orderedProjects,
    projectGroups,
    normalThreads,
    currentThreadId: currentChat?.threadId || ""
  });

  return { cardKitCard, fallbackCard };
}

function buildCardKit2({ currentProject, currentThreadName, orderedProjects, projectGroups, normalThreads, currentThreadId }) {
  const elements = [
    sectionTitle("当前", "check-one_outlined"),
    currentBlock(currentProject, currentThreadName),
    divider(),
    sectionTitle("项目", "folder_outlined")
  ];

  orderedProjects.forEach((project, index) => {
    const list = projectGroups.get(project) || [];
    const names = dedupeNames(list.map(displayThreadName));
    const isCurrent = list.some((thread) => thread.id === currentThreadId);
    elements.push(projectBlock({
      title: `${index + 1}. ${project}${isCurrent ? " · 当前" : ""}`,
      names,
      isCurrent
    }));
  });

  if (normalThreads.length) {
    const names = dedupeNames(normalThreads.map(displayThreadName));
    elements.push(divider());
    elements.push(sectionTitle("普通会话", "chat_outlined"));
    elements.push(sessionListBlock(names));
  }

  elements.push(divider());
  elements.push(markdown(`<font color='grey'>项目 ${orderedProjects.length} 个，普通会话 ${normalThreads.length} 个</font>`, {
    textSize: "notation",
    margin: "0px 0px 0px 0px"
  }));

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: { content: "Codex 项目与普通会话" }
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Codex 项目与普通会话" },
      subtitle: { tag: "plain_text", content: "按桌面项目分组展示" }
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements
    }
  };
}

function buildFallbackCard({ currentProject, currentThreadName, orderedProjects, projectGroups, normalThreads, currentThreadId }) {
  const elements = [
    { tag: "div", text: { tag: "plain_text", content: `当前\n项目：${currentProject}\n会话：${currentThreadName}` } },
    { tag: "hr" },
    { tag: "div", text: { tag: "plain_text", content: "项目" } }
  ];

  orderedProjects.forEach((project, index) => {
    const list = projectGroups.get(project) || [];
    const names = dedupeNames(list.map(displayThreadName));
    const isCurrent = list.some((thread) => thread.id === currentThreadId);
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: `${index + 1}. ${project}${isCurrent ? " 当前" : ""}\n${names.map((name, i) => `${i + 1}. ${name}`).join("\n")}`
      }
    });
  });

  if (normalThreads.length) {
    const names = dedupeNames(normalThreads.map(displayThreadName));
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "plain_text", content: `普通会话\n${names.map((name, i) => `${i + 1}. ${name}`).join("\n")}` }
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "Codex 项目与普通会话" } },
    elements
  };
}

function sectionTitle(title, iconToken) {
  return {
    tag: "div",
    icon: {
      tag: "standard_icon",
      token: iconToken,
      color: "blue",
      size: "18px 18px"
    },
    text: {
      tag: "lark_md",
      content: `**${escapeMarkdown(title)}**`,
      text_size: "large"
    },
    margin: "2px 0px 6px 0px"
  };
}

function currentBlock(project, threadName) {
  return {
    tag: "column_set",
    flex_mode: "none",
    margin: "0px 0px 8px 0px",
    padding: "2px 0px 6px 0px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        markdown(`**${escapeMarkdown(project)}**`, { textSize: "heading" }),
        markdown(`**当前会话：${escapeMarkdown(threadName)}**`, { textSize: "heading" })
      ]
    }]
  };
}

function projectBlock({ title, names, isCurrent }) {
  return {
    tag: "column_set",
    margin: "0px 0px 8px 0px",
    padding: "2px 0px 6px 0px",
    flex_mode: "none",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        markdown(`**${escapeMarkdown(title)}**`, { textSize: "heading", margin: "0px 0px 4px 0px" }),
        markdown(names.map((name) => `· ${escapeMarkdown(name)}`).join("\n"), {
          textSize: "normal",
          margin: "0px 0px 0px 0px"
        })
      ]
    }]
  };
}

function sessionListBlock(names) {
  return {
    tag: "column_set",
    margin: "0px 0px 8px 0px",
    padding: "2px 0px 6px 0px",
    flex_mode: "none",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        markdown(names.map((name) => `· ${escapeMarkdown(name)}`).join("\n"), {
          textSize: "normal",
          margin: "0px 0px 0px 0px"
        })
      ]
    }]
  };
}

function markdown(content, { textSize = "normal", margin = "0px 0px 0px 0px" } = {}) {
  return {
    tag: "markdown",
    content,
    text_align: "left",
    text_size: textSize,
    margin
  };
}

function divider() {
  return { tag: "hr", margin: "4px 0px 8px 0px" };
}

function groupThreads(threads, savedRoots) {
  const projectGroups = new Map();
  const normalThreads = [];
  for (const thread of threads) {
    const matchedRoot = matchingProjectRoot(thread.cwd, savedRoots);
    if (matchedRoot) {
      const project = projectLabel(path.basename(matchedRoot));
      if (!projectGroups.has(project)) projectGroups.set(project, []);
      projectGroups.get(project).push(thread);
    } else {
      normalThreads.push(thread);
    }
  }
  return { projectGroups, normalThreads };
}

function shouldShowThread(thread) {
  const name = displayThreadName(thread);
  if (!name || name === "(untitled)") return false;
  if (name.includes("????")) return false;
  if (/^default$/i.test(name)) return false;
  if (/^feishu-mobile-default$/i.test(name)) return false;
  return true;
}

function displayThreadName(thread) {
  const name = String(thread.name || "").trim();
  if (name) return name;
  const preview = String(thread.preview || "").trim().replace(/\s+/g, " ");
  return preview ? preview.slice(0, 22) : "(untitled)";
}

function matchingProjectRoot(cwd, roots) {
  const value = normalizePath(cwd);
  if (!value) return "";
  return roots
    .filter((root) => value === root || value.startsWith(`${root}\\`))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function projectLabel(base) {
  return base || "未命名项目";
}

function normalizePath(value) {
  return String(value || "").replace(/\//g, "\\").replace(/\\+$/, "");
}

function dedupeNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}（${count}）`;
  });
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/([*_`])/g, "\\$1");
}
