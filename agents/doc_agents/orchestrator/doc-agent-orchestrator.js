import { Codex } from "@openai/codex-sdk";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import path from "path";

const cwd = process.cwd();

const safeRead = (p) => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
};

const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const resolvePath = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(cwd, p)));

const truncate = (text, limit) => {
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n<!-- truncated, original length ${text.length} -->`;
};

const collectFilesRecursive = (dir, limit, acc = []) => {
  if (!dir || !existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, limit, acc);
    } else {
      acc.push(`--- ${full} ---\n${truncate(safeRead(full), limit)}`);
    }
  }
  return acc;
};

const loadRuleFilesContent = (paths) =>
  (paths || [])
    .map((p) => safeRead(p).trim())
    .filter(Boolean)
    .join("\n\n");

const loadAdditionalFileContent = (paths, limit) =>
  (paths || [])
    .map((p) => `--- ${p} ---\n${truncate(safeRead(p), limit)}`)
    .join("\n\n");

const loadDirectoryContent = (dirs, limit) => {
  const chunks = [];
  (dirs || []).forEach((dir) => collectFilesRecursive(dir, limit, chunks));
  return chunks.join("\n\n");
};

function extractJsonFromResponse(rawResponse, agentName) {
  const fenced = rawResponse.match(/```json\s*([\s\S]*?)```/);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }
  const firstBrace = rawResponse.indexOf("{");
  const lastBrace = rawResponse.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(rawResponse.substring(firstBrace, lastBrace + 1));
  }
  const snippet = rawResponse ? rawResponse.slice(0, 400) : "<empty>";
  throw new Error(`${agentName}: не найден JSON-блок. Пример ответа: ${snippet}`);
}

const estimateTokens = (text) => Math.ceil((text || "").length / 4);

const parseTaskDescription = (taskFile) => {
  const raw = safeRead(taskFile);
  const [first, ...rest] = raw.split(/\r?\n/);
  return { targetDir: resolvePath(first.trim()), taskText: rest.join("\n").trim() };
};

const snapshotFiles = (mainPath, additionalPaths, feedback) => {
  const parts = [];
  const main = safeRead(mainPath);
  if (main) parts.push(`--- ${mainPath} ---\n${main}`);
  if (additionalPaths?.length) {
    parts.push(
      additionalPaths
        .map((p) => `--- ${p} ---\n${safeRead(p)}`)
        .join("\n\n")
    );
  }
  if (feedback) parts.push(`--- Предыдущее замечание ---\n${feedback}`);
  return parts.join("\n\n");
};

async function runAgentWorkflow() {
  const configPath = process.argv[2] || "agents/doc_agents/config/task-config.json";
  const config = JSON.parse(safeRead(configPath));

  const {
    topic,
    outputTaskDocsDir,
    taskDescriptionFile,
    allowAdditionalFiles,
    maxIterations,
    dialogueLogFile,
    primaryAgentPromptFile,
    secondaryAgentPromptFile,
    docsReadmeFile,
    additionalContextFiles,
    additionalContextDirectories,
    primaryAgentRuleFiles,
    secondaryAgentRuleFiles,
    maxContextChars,
    maxAdditionalContextChars,
    tokenReportInterval,
    maxTokensPerAgentCall,
    writerModel,
    reviewerModel,
  } = config;

  const { targetDir, taskText } = parseTaskDescription(taskDescriptionFile);
  const outputBaseDir = targetDir || resolvePath(outputTaskDocsDir) || resolvePath("docs/generated");
  ensureDir(outputBaseDir);

  const logLines = [];
  const appendLog = (line) => {
    logLines.push(line);
    if (dialogueLogFile) {
      ensureDir(path.dirname(dialogueLogFile));
      writeFileSync(dialogueLogFile, logLines.join("\n") + "\n", "utf-8");
    }
  };

  appendLog(`Config: ${JSON.stringify(config, null, 2)}`);
  appendLog(`Output dir: ${outputBaseDir}`);

  const additionalFilesCtx = truncate(loadAdditionalFileContent(additionalContextFiles, maxAdditionalContextChars), maxAdditionalContextChars);
  const directoriesCtx = truncate(loadDirectoryContent(additionalContextDirectories, maxAdditionalContextChars), maxAdditionalContextChars);
  const totalAdditionalContext = [additionalFilesCtx, directoriesCtx].filter(Boolean).join("\n\n");

  const primaryRules = loadRuleFilesContent(primaryAgentRuleFiles);
  const secondaryRules = loadRuleFilesContent(secondaryAgentRuleFiles);

  const primaryPromptBase = safeRead(primaryAgentPromptFile);
  const secondaryPromptBase = safeRead(secondaryAgentPromptFile);

  const defaultMainFile = path.join(outputBaseDir, "index.md");
  const defaultTasksFile = path.join(outputBaseDir, "tasks.md");
  [defaultMainFile, defaultTasksFile].forEach((p) => {
    if (!existsSync(p)) writeFileSync(p, "", "utf-8");
  });

  const primaryAgentCodex = writerModel ? new Codex({ model: writerModel }) : new Codex();
  const secondaryAgentCodex = reviewerModel ? new Codex({ model: reviewerModel }) : new Codex();
  const primaryAgentThread = primaryAgentCodex.startThread();
  const secondaryAgentThread = secondaryAgentCodex.startThread();

  let iteration = 1;
  let isComplete = false;
  let feedback = "";
  let totalEstimatedTokens = 0;
  let trackedAdditionalFiles = [];

  while (!isComplete && iteration <= maxIterations) {
    console.log(`\n=== Итерация ${iteration} ===`);

    const writerPrompt = primaryPromptBase
      .replace("{{TOPIC}}", topic)
      .replace("{{TASK_DESCRIPTION_CONTENT}}", taskText)
      .replace("{{ADDITIONAL_CONTEXT}}", totalAdditionalContext)
      .replace("{{AGENT_RULES}}", primaryRules)
      .replace("{{OUTPUT_MAIN_FILE}}", defaultMainFile);

    const stateSnapshot = truncate(snapshotFiles(defaultMainFile, trackedAdditionalFiles, feedback), maxContextChars);
    const writerPromptFull = `${writerPrompt}\n\n---\nТекущее содержимое файлов:\n${stateSnapshot || "(пусто)"}`;

    const writerResult = await primaryAgentThread.run(writerPromptFull, { maxOutputTokens: maxTokensPerAgentCall });
    const writerRaw = writerResult.finalResponse || writerResult.output || writerResult || "";
    const writerJson = extractJsonFromResponse(writerRaw, "writer");

    const writerTokens = estimateTokens(writerPromptFull) + estimateTokens(writerRaw);
    totalEstimatedTokens += writerTokens;
    console.log(`[tokens] writer ~${writerTokens}, total ~${totalEstimatedTokens}`);

    const mainFilePath = path.isAbsolute(writerJson.mainFilePath || "") ? path.normalize(writerJson.mainFilePath) : defaultMainFile;
    const mainContent = writerJson.mainContent || "";
    if (!mainContent.trim()) throw new Error("writer: mainContent пуст — нечего писать в главный файл");
    ensureDir(path.dirname(mainFilePath));
    writeFileSync(mainFilePath, mainContent, "utf-8");

    const additionalFiles = allowAdditionalFiles && Array.isArray(writerJson.additionalFiles) ? writerJson.additionalFiles : [];
    const writtenAdditional = [];
    for (const f of additionalFiles) {
      if (!f?.filePath || !f?.content) continue;
      const targetPath = path.isAbsolute(f.filePath) ? path.normalize(f.filePath) : path.join(outputBaseDir, path.basename(f.filePath));
      ensureDir(path.dirname(targetPath));
      writeFileSync(targetPath, f.content, "utf-8");
      writtenAdditional.push(targetPath);
    }
    trackedAdditionalFiles = writtenAdditional;

    const mainContentForReview = truncate(safeRead(mainFilePath), maxContextChars);
    const additionalContentForReview = truncate(
      writtenAdditional.map((p) => `--- ${p} ---\n${safeRead(p)}`).join("\n\n"),
      maxContextChars
    );

    if (tokenReportInterval === "before_review") {
      console.log(`[tokens] перед проверкой ~${totalEstimatedTokens}`);
    }

    const reviewerPrompt = secondaryPromptBase
      .replace("{{TOPIC}}", topic)
      .replace("{{AGENT_RULES}}", secondaryRules)
      .replace("{{MAIN_FILE_CONTENT}}", mainContentForReview || "(файл пуст)")
      .replace("{{ADDITIONAL_FILES_COMBINED_CONTENT}}", additionalContentForReview || "(доп. файлы отсутствуют)")
      .replace("{{ADDITIONAL_CONTEXT}}", totalAdditionalContext)
      .replace("{{OUTPUT_MAIN_FILE}}", defaultMainFile);

    const reviewerResult = await secondaryAgentThread.run(reviewerPrompt, { maxOutputTokens: maxTokensPerAgentCall });
    const reviewerRaw = reviewerResult.finalResponse || reviewerResult.output || reviewerResult || "";
    const reviewerJson = extractJsonFromResponse(reviewerRaw, "reviewer");

    const reviewerTokens = estimateTokens(reviewerPrompt) + estimateTokens(reviewerRaw);
    totalEstimatedTokens += reviewerTokens;
    console.log(`[tokens] reviewer ~${reviewerTokens}, total ~${totalEstimatedTokens}`);

    feedback = reviewerJson.feedback || "";
    isComplete = reviewerJson.isComplete === true;

    console.log(`writer: main=${mainFilePath}, additional=${trackedAdditionalFiles.length ? trackedAdditionalFiles.join(", ") : "нет"}`);
    console.log(`reviewer: ${feedback || "замечаний нет"}`);
    console.log(`статус: ${isComplete ? "завершено" : "нужны правки"}`);

    appendLog(
      [
        `--- Итерация ${iteration} ---`,
        `writer JSON: ${JSON.stringify(writerJson)}`,
        `reviewer JSON: ${JSON.stringify(reviewerJson)}`,
        `feedback: ${feedback}`,
        `isComplete: ${isComplete}`,
        `tokens total ~${totalEstimatedTokens}`,
      ].join("\n")
    );

    iteration += 1;
  }

  if (!isComplete) {
    console.warn(`Достигнут лимит итераций (${maxIterations}), задача не завершена.`);
  } else {
    console.log("Готово: статус завершено.");
  }
}

runAgentWorkflow().catch((err) => {
  console.error("Ошибка оркестратора:", err.message);
  process.exit(1);
});
