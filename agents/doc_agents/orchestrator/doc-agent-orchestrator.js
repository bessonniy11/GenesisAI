/**
 * Оркестратор двух агентов (писатель + проверяющий) для генерации документации.
 * Шаги:
 * 1) Читает конфиг и описание задачи.
 * 2) Собирает правила и дополнительный контекст.
 * 3) Запускает писателя: получает JSON с путями и контентом, пишет файлы.
 * 4) Запускает проверяющего: оценивает консистентность, решает завершена ли задача.
 * 5) Логирует ход работы и примерные токены.
 */
import { Codex } from "@openai/codex-sdk";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import path from "path";

const cwd = process.cwd();

/**
 * Безопасно читает файл в UTF-8.
 * @param {string} p Путь до файла.
 * @returns {string} Содержимое или пустая строка при ошибке.
 */
const safeRead = (p) => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
};

/**
 * Создаёт каталог при отсутствии (mkdir -p).
 * @param {string} dir Путь к каталогу.
 */
const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

/**
 * Нормализует путь: абсолютный сохраняет, относительный резолвит от cwd.
 * @param {string} p Путь.
 * @returns {string} Нормализованный путь.
 */
const resolvePath = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(cwd, p)));

/**
 * Обрезает текст до лимита, добавляя маркер.
 * @param {string} text Текст.
 * @param {number} limit Лимит символов.
 * @returns {string} Исходный или обрезанный текст.
 */
const truncate = (text, limit) => {
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n<!-- truncated, original length ${text.length} -->`;
};

/**
 * Рекурсивно собирает содержимое файлов из каталога с усечением.
 * @param {string} dir Каталог.
 * @param {number} limit Лимит символов на файл.
 * @param {string[]} acc Аккумулятор.
 * @returns {string[]} Накопленные куски.
 */
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

/**
 * Склеивает содержимое файлов правил.
 * @param {string[]} paths Пути к файлам.
 * @returns {string} Правила одной строкой.
 */
const loadRuleFilesContent = (paths) =>
  (paths || [])
    .map((p) => safeRead(p).trim())
    .filter(Boolean)
    .join("\n\n");

/**
 * Подгружает дополнительные файлы с усечением.
 * @param {string[]} paths Пути.
 * @param {number} limit Лимит символов.
 * @returns {string} Контекст.
 */
const loadAdditionalFileContent = (paths, limit) =>
  (paths || [])
    .map((p) => `--- ${p} ---\n${truncate(safeRead(p), limit)}`)
    .join("\n\n");

/**
 * Подгружает содержимое директорий рекурсивно с усечением.
 * @param {string[]} dirs Каталоги.
 * @param {number} limit Лимит символов.
 * @returns {string} Контекст по дереву каталогов.
 */
const loadDirectoryContent = (dirs, limit) => {
  const chunks = [];
  (dirs || []).forEach((dir) => collectFilesRecursive(dir, limit, chunks));
  return chunks.join("\n\n");
};

/**
 * Извлекает JSON из ответа LLM: сначала fenced ```json```, затем по скобкам.
 * @param {string} rawResponse Ответ модели.
 * @param {string} agentName Имя агента (для сообщения об ошибке).
 * @returns {object} Распарсенный JSON.
 * @throws Если JSON не найден или не парсится.
 */
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

/**
 * Приблизительно оценивает токены (символы / 4).
 * @param {string} text Текст.
 * @returns {number} Оценка количества токенов.
 */
const estimateTokens = (text) => Math.ceil((text || "").length / 4);

/**
 * Парсит файл описания задачи: первая строка — целевой каталог, дальше текст.
 * @param {string} taskFile Путь к файлу описания.
 * @returns {{targetDir: string, taskText: string}}
 */
const parseTaskDescription = (taskFile) => {
  const raw = safeRead(taskFile);
  const [first, ...rest] = raw.split(/\r?\n/);
  return { targetDir: resolvePath(first.trim()), taskText: rest.join("\n").trim() };
};

/**
 * Делает снимок текущих файлов и последнего отзыва.
 * @param {string} mainPath Главный файл.
+ * @param {string[]} additionalPaths Дополнительные файлы.
 * @param {string} feedback Текст отзыва.
 * @returns {string} Снимок для контекста.
 */
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

/**
 * Главный цикл: подготавливает контекст, запускает писателя и проверяющего,
 * пишет файлы и выводит токен-отчёт до завершения или достижения лимита итераций.
 */
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
    console.log(`Токены всего ~${totalEstimatedTokens}`);
  }
}

runAgentWorkflow().catch((err) => {
  console.error("Ошибка оркестратора:", err.message);
  process.exit(1);
});
