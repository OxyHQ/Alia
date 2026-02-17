import chalk from 'chalk';
import * as readline from 'readline';

// Gradient colors for the banner (cyan to magenta)
const gradientColors = [
  '#00d4ff', '#00c4ff', '#00b4ff', '#00a4ff',
  '#4094ff', '#8084ff', '#c074ff', '#ff64ff'
];

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    : [255, 255, 255];
}

function colorize(text: string, colorIndex: number, totalColors: number): string {
  const ratio = colorIndex / totalColors;
  const startColor = hexToRgb(gradientColors[0]);
  const endColor = hexToRgb(gradientColors[gradientColors.length - 1]);

  const r = Math.round(startColor[0] + ratio * (endColor[0] - startColor[0]));
  const g = Math.round(startColor[1] + ratio * (endColor[1] - startColor[1]));
  const b = Math.round(startColor[2] + ratio * (endColor[2] - startColor[2]));

  return chalk.rgb(r, g, b)(text);
}

// ASCII art banner with gradient
export function printBanner(): void {
  const banner = [
    '   ██████╗ ██████╗ ██████╗ ███████╗ █████╗ ',
    '  ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗',
    '  ██║     ██║   ██║██║  ██║█████╗  ███████║',
    '  ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██║',
    '  ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║',
    '   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
  ];

  console.log();
  banner.forEach((line, i) => {
    let coloredLine = '';
    for (let j = 0; j < line.length; j++) {
      coloredLine += colorize(line[j], j, line.length);
    }
    console.log(coloredLine);
  });
  console.log(chalk.gray('  by Alia'));
  console.log();
}

export function printTips(): void {
  console.log(chalk.white('Tips for getting started:'));
  console.log(chalk.gray('1. Ask questions, edit files, or run commands.'));
  console.log(chalk.gray('2. Be specific for the best results.'));
  console.log(chalk.gray('3. ') + chalk.cyan('/help') + chalk.gray(' for more information.'));
  console.log();
}

export function printPrompt(): void {
  process.stdout.write(chalk.cyan('❯ '));
}

export function printToolExecution(tool: string, description: string): void {
  const boxWidth = Math.min(process.stdout.columns || 80, 80);
  const content = `${chalk.bold(tool)} ${description}`;
  const paddedContent = ` ← ${content} `.padEnd(boxWidth - 4);

  console.log();
  console.log(chalk.gray('┌' + '─'.repeat(boxWidth - 2) + '┐'));
  console.log(chalk.gray('│') + paddedContent + chalk.gray('│'));
  console.log(chalk.gray('└' + '─'.repeat(boxWidth - 2) + '┘'));
}

export function printToolResult(success: boolean, result: string): void {
  const status = success ? chalk.green('✓') : chalk.red('✗');
  const preview = result.slice(0, 100).replace(/\n/g, ' ');
  console.log(`  ${status} ${chalk.gray(preview)}${result.length > 100 ? '...' : ''}`);
  console.log();
}

let statusInterval: NodeJS.Timeout | null = null;
let startTime: number = 0;

export function showThinkingStatus(message: string): void {
  startTime = Date.now();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;

  statusInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const frame = frames[frameIndex % frames.length];
    frameIndex++;

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(
      chalk.cyan(frame) + ' ' +
      chalk.bold(message) +
      chalk.gray(` (esc to cancel, ${elapsed}s)`)
    );
  }, 80);
}

export function hideThinkingStatus(): void {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

export function printStatusBar(cwd: string, model: string, contextPercent: number): void {
  const width = process.stdout.columns || 80;
  const cwdPart = chalk.cyan(shortenPath(cwd));
  const modelPart = chalk.magenta(`${model} (${contextPercent}% context left)`);

  const padding = width - stripAnsi(cwdPart).length - stripAnsi(modelPart).length - 4;
  const spacer = ' '.repeat(Math.max(padding, 2));

  console.log();
  console.log(chalk.gray('─'.repeat(width)));
  console.log(`${cwdPart}${spacer}${modelPart}`);
}

function shortenPath(p: string): string {
  const home = process.env.HOME || '';
  if (p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function printAssistantPrefix(): void {
  process.stdout.write(chalk.magenta('✦ '));
}

export function printError(message: string): void {
  console.log(chalk.red('✗ Error: ') + message);
}

export function printSuccess(message: string): void {
  console.log(chalk.green('✓ ') + message);
}

export function printInfo(message: string): void {
  console.log(chalk.blue('ℹ ') + message);
}
