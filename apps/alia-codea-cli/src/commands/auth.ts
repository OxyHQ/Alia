import * as readline from 'readline';
import chalk from 'chalk';
import { config } from '../utils/config.js';
import { printSuccess, printError, printInfo } from '../utils/ui.js';

export async function login(): Promise<void> {
  console.log();
  console.log(chalk.bold('Codea CLI Login'));
  console.log(chalk.gray('Enter your Alia API key to get started.'));
  console.log(chalk.gray('Get your API key at: ') + chalk.cyan('https://alia.onl/settings/api'));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(chalk.cyan('API Key: '), async (apiKey) => {
      rl.close();

      const trimmedKey = apiKey.trim();

      if (!trimmedKey) {
        printError('No API key provided.');
        resolve();
        return;
      }

      // Validate the API key by making a test request
      printInfo('Validating API key...');

      try {
        const baseUrl = config.get('apiBaseUrl') || 'https://api.alia.onl';
        const response = await fetch(`${baseUrl}/codea/me`, {
          headers: {
            'Authorization': `Bearer ${trimmedKey}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          config.set('apiKey', trimmedKey);
          console.log();
          printSuccess(`Logged in successfully!`);
          if (data.name) {
            console.log(chalk.gray(`Welcome, ${data.name}!`));
          }
          console.log();
          console.log(chalk.gray('Run ') + chalk.cyan('codea') + chalk.gray(' to start coding.'));
        } else {
          printError('Invalid API key. Please check and try again.');
        }
      } catch (error: any) {
        printError(`Could not validate API key: ${error.message}`);
      }

      resolve();
    });
  });
}

export function logout(): void {
  config.delete('apiKey');
  printSuccess('Logged out successfully.');
}
