import {
  apply,
  chain,
  mergeWith,
  move,
  noop,
  Rule,
  SchematicContext,
  template,
  Tree,
  url
} from '@angular-devkit/schematics';
import { NodePackageInstallTask } from '@angular-devkit/schematics/tasks';
import { join, normalize } from '@angular-devkit/core';
// app
import {
  getProjectConfig,
  readJsonInTree,
  updateJsonInTree
} from '../../utils/ast-utils';
import { testcafeVersion, nxVersion } from '../../lib-versions';
import { replaceAppNameWithPath } from '../../utils/cli-config-utils';
import { offsetFromRoot } from '../../utils/common';
import { Schema } from '../application/schema';

export interface TestCafeProjectSchema extends Schema {
  appProjectRoot: string;
  e2eProjectName: string;
  e2eProjectRoot: string;
}

function checkArchitectTarget(options: TestCafeProjectSchema): Rule {
  return (host: Tree): Rule => {
    const projectConfig = getProjectConfig(host, options.e2eProjectName);
    if (!projectConfig.architect.e2e) {
      return updateJsonInTree('angular.json', json => {
        json.projects[options.e2eProjectName] = {};
        return json;
      });
    }

    return noop();
  };
}

function installDependencies(
  dependencyList: { name: string; version: string }[]
): Rule {
  const addedDependencies = dependencyList.reduce((dictionary, value) => {
    dictionary[value.name] = value.version;
    return dictionary;
  }, {});
  const updatePackageJson: Rule = updateJsonInTree('package.json', json => {
    return {
      ...json,
      devDependencies: {
        ...json.devDependencies,
        ...addedDependencies
      }
    };
  });

  function doInstall(host: Tree, context: SchematicContext): void {
    context.addTask(new NodePackageInstallTask());
  }

  return chain([updatePackageJson, doInstall]);
}

function checkDependenciesInstalled(): Rule {
  return (host: Tree): Rule => {
    const packageJson = readJsonInTree(host, 'package.json');
    const dependencyList: { name: string; version: string }[] = [];
    if (!packageJson.devDependencies.cypress) {
      dependencyList.push({ name: 'cypress', version: testcafeVersion });
      // NOTE: Need to be removed on the next Cypress release (=>3.1.1)
      dependencyList.push({ name: '@types/jquery', version: '3.3.6' });
    }
    if (!packageJson.devDependencies['@nrwl/builders']) {
      dependencyList.push({ name: '@nrwl/builders', version: nxVersion });
    }

    if (!dependencyList.length) {
      return noop();
    }

    return installDependencies(dependencyList);
  };
}

function generateFiles(options: TestCafeProjectSchema): Rule {
  return (host: Tree): Rule => {
    host.delete(`${options.e2eProjectRoot}/tsconfig.e2e.json`);
    const projectConfig = getProjectConfig(host, options.e2eProjectName);
    return mergeWith(
      apply(url('./files'), [
        template({
          tmpl: '',
          projectName: options.e2eProjectName,
          relatedProjectName: options.name,
          projectRoot: projectConfig.root,
          offsetFromRoot: offsetFromRoot(projectConfig.root)
        }),
        move(projectConfig.root)
      ])
    );
  };
}

function updateAngularJson(options: TestCafeProjectSchema): Rule {
  return updateJsonInTree('angular.json', json => {
    const projectConfig = json.projects[options.e2eProjectName];
    projectConfig.root = options.e2eProjectRoot;

    projectConfig.architect.e2e = {
      builder: '@nrwl/builders:test-cafe',
      options: {
        devServerTarget: `${options.name}:serve`
      },
      configurations: {
        production: {
          devServerTarget: `${options.name}:serve:production`
        }
      }
    };
    json.projects[options.e2eProjectName] = projectConfig;
    return json;
  });
}

export default function(options: TestCafeProjectSchema): Rule {
  return chain([
    checkArchitectTarget(options),
    checkDependenciesInstalled(),
    updateAngularJson(options),
    generateFiles(options)
  ]);
}
