import {
  Builder,
  BuilderConfiguration,
  BuilderContext,
  BuildEvent
} from '@angular-devkit/architect';
import { Observable, of, Subscriber, noop } from 'rxjs';
import { catchError, concatMap, tap, map, take } from 'rxjs/operators';
import { ChildProcess, fork } from 'child_process';
import { copySync, removeSync } from 'fs-extra';
import { fromPromise } from 'rxjs/internal-compatibility';
import { DevServerBuilderOptions } from '@angular-devkit/build-angular';
import { readFile } from '@angular-devkit/schematics/tools/file-system-utility';
import { getSystemPath, join } from '@angular-devkit/core';
import * as path from 'path';
import * as url from 'url';
import * as treeKill from 'tree-kill';
const createTestCafe = require('testcafe'); // @NOTE: Importing via ES6 messes the whole test dependencies.

export interface TestCafeBuilderOptions {
  browsers?: string[];
  devServerTarget?: string;
}

/**
 * @whatItDoes Implementation of the TestCafe Builder, compile Typescript files,
 * build the devServer to serve the app then run TestCafe e2e test runner.
 * The builder needs some information from the `angular.json` file:
 * @example:
```
 "my-app-e2e": {
    "root": "apps/my-app-e2e/",
    "projectType": "application",
    "architect": {
      "e2e": {
        "builder": "@nrwl/builders:test-cafe",
        "options": {
          "cypressConfig": "apps/my-app-e2e/cypress.json",
          "tsConfig": "apps/my-app-e2e/tsconfig.json",
          "devServerTarget": "my-app:serve"
      },
      "configurations": {
        "production": {
          "devServerTarget": "my-app:serve:production"
        }
      }
      }
    }
 }
```
 *
 */
export default class TestCafeBuilder
  implements Builder<TestCafeBuilderOptions> {
  private computedTestCafeBaseUrl: string;
  private tscProcess: ChildProcess = null;

  constructor(public context: BuilderContext) {}

  /**
   * @whatItDoes This is the starting point of the builder.
   * @param builderConfig
   */
  run(
    builderConfig: BuilderConfiguration<TestCafeBuilderOptions>
  ): Observable<BuildEvent> {
    const options = builderConfig.options;

    const build = options.devServerTarget
      ? this.startDevServer(options.devServerTarget, false)
      : of(null);

    return build.pipe(
      concatMap(() => this.initTestCafe(builderConfig.root, options.browsers)),
      take(1),
      catchError(error => {
        throw new Error(error);
      })
    );
  }

  /**
   * @whatItDoes Initialize the Cypress test runner with the provided project configuration.
   * If `headless` is `false`: open the Cypress application, the user will
   * be able to interact directly with the application.
   * If `headless` is `true`: Cypress will run in headless mode and will
   * provide directly the results in the console output.
   * @param srcPath
   * @param browsers
   */
  private initTestCafe(
    srcPath: string,
    browsers: string[]
  ): Observable<BuildEvent> {
    let testCafe = null;
    let runner = null;
    return fromPromise<BuildEvent>(
      createTestCafe('localhost', 1337, 1338)
        .then(tc => {
          testCafe = tc;
          runner = testCafe.createRunner();
          return runner
            .src(srcPath)
            .browsers(browsers)
            .run();
        })
        .then((failedCount: number) => {
          testCafe.close();
          return {
            success: failedCount === 0
          };
        })
    );
  }

  /**
   * @whatItDoes Compile the application using the webpack builder.
   * @param devServerTarget
   * @param isWatching
   * @private
   */
  private startDevServer(
    devServerTarget: string,
    isWatching: boolean
  ): Observable<BuildEvent> {
    const architect = this.context.architect;
    const [project, targetName, configuration] = devServerTarget.split(':');
    // Overrides dev server watch setting.
    const overrides: Partial<DevServerBuilderOptions> = { watch: isWatching };
    const targetSpec = {
      project,
      target: targetName,
      configuration,
      overrides: overrides
    };
    const builderConfig = architect.getBuilderConfiguration<
      DevServerBuilderOptions
    >(targetSpec);

    return architect.getBuilderDescription(builderConfig).pipe(
      concatMap(devServerDescription =>
        architect.validateBuilderOptions(builderConfig, devServerDescription)
      ),
      tap(builderConfig => {
        if (devServerTarget && builderConfig.options.publicHost) {
          let publicHost = builderConfig.options.publicHost;
          if (!/^\w+:\/\//.test(publicHost)) {
            publicHost = `${
              builderConfig.options.ssl ? 'https' : 'http'
            }://${publicHost}`;
          }
          const clientUrl = url.parse(publicHost);
          this.computedTestCafeBaseUrl = url.format(clientUrl);
        } else if (devServerTarget) {
          this.computedTestCafeBaseUrl = url.format({
            protocol: builderConfig.options.ssl ? 'https' : 'http',
            hostname: builderConfig.options.host,
            port: builderConfig.options.port.toString()
          });
        }
      }),
      concatMap(builderConfig => architect.run(builderConfig, this.context))
    );
  }

  private killProcess(): void {
    return treeKill(this.tscProcess.pid, 'SIGTERM', error => {
      this.tscProcess = null;
      if (error) {
        if (Array.isArray(error) && error[0] && error[2]) {
          const errorMessage = error[2];
          this.context.logger.error(errorMessage);
        } else if (error.message) {
          this.context.logger.error(error.message);
        }
      }
    });
  }
}
