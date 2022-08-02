import {
  ClientSideBaseVisitor,
  ClientSideBasePluginConfig,
  LoadedFragment,
  getConfigValue,
  OMIT_TYPE,
  DocumentMode,
} from '@graphql-codegen/visitor-plugin-common';
import { UrqlRawPluginConfig } from './config.js';
import autoBind from 'auto-bind';
import { OperationDefinitionNode, Kind, GraphQLSchema } from 'graphql';

export interface UrqlPluginConfig extends ClientSideBasePluginConfig {
  withComponent: boolean;
  withHooks: boolean;
  withLoaders: boolean | string;
  urqlImportFrom: string;
}

export class UrqlVisitor extends ClientSideBaseVisitor<UrqlRawPluginConfig, UrqlPluginConfig> {
  private _externalImportPrefix = '';

  constructor(schema: GraphQLSchema, fragments: LoadedFragment[], rawConfig: UrqlRawPluginConfig) {
    super(schema, fragments, rawConfig, {
      withComponent: getConfigValue(rawConfig.withComponent, false),
      withLoaders: getConfigValue(rawConfig.withLoaders, false),
      withHooks: getConfigValue(rawConfig.withHooks, true),
      urqlImportFrom: getConfigValue(rawConfig.urqlImportFrom, null),
    });

    if (this.config.importOperationTypesFrom) {
      this._externalImportPrefix = `${this.config.importOperationTypesFrom}.`;

      if (this.config.documentMode !== DocumentMode.external || !this.config.importDocumentNodeExternallyFrom) {
        // eslint-disable-next-line no-console
        console.warn(
          '"importOperationTypesFrom" should be used with "documentMode=external" and "importDocumentNodeExternallyFrom"'
        );
      }

      if (this.config.importOperationTypesFrom !== 'Operations') {
        // eslint-disable-next-line no-console
        console.warn('importOperationTypesFrom only works correctly when left empty or set to "Operations"');
      }
    }

    autoBind(this);
  }

  public getImports(): string[] {
    const baseImports = super.getImports();
    const imports = [];
    const hasOperations = this._collectedOperations.length > 0;

    if (!hasOperations) {
      return baseImports;
    }

    if (this.config.withComponent) {
      imports.push(`import * as React from 'react';`);
    }
    if (typeof this.config.withLoaders === 'string') {
      const [source, import_ = 'default'] = this.config.withLoaders.split('#');
      imports.push(`import { ${import_ ?? 'default'} as client } from '${source}' `);
    }
    if (this.config.withLoaders) {
      imports.push(`import * as ReactRouter from 'react-router';`);
    }

    if (this.config.withComponent || this.config.withHooks || this.config.withLoaders) {
      imports.push(`import * as Urql from '${this.config.urqlImportFrom || 'urql'}';`);
    }

    imports.push(OMIT_TYPE);

    return [...baseImports, ...imports];
  }

  private _buildComponent(
    node: OperationDefinitionNode,
    documentVariableName: string,
    operationType: string,
    operationResultType: string,
    operationVariablesTypes: string
  ): string {
    const componentName: string = this.convertName(node.name?.value ?? '', {
      suffix: 'Component',
      useTypesPrefix: false,
    });

    const isVariablesRequired =
      operationType === 'Query' &&
      node.variableDefinitions.some(variableDef => variableDef.type.kind === Kind.NON_NULL_TYPE);

    const generics = [operationResultType, operationVariablesTypes];

    if (operationType === 'Subscription') {
      generics.unshift(operationResultType);
    }
    return `
export const ${componentName} = (props: Omit<Urql.${operationType}Props<${generics.join(
      ', '
    )}>, 'query'> & { variables${isVariablesRequired ? '' : '?'}: ${operationVariablesTypes} }) => (
  <Urql.${operationType} {...props} query={${documentVariableName}} />
);
`;
  }

  private _buildHooks(
    node: OperationDefinitionNode,
    operationType: string,
    documentVariableName: string,
    operationResultType: string,
    operationVariablesTypes: string
  ): string {
    const operationName: string = this.convertName(node.name?.value ?? '', {
      suffix: this.getOperationSuffix(node, operationType),
      useTypesPrefix: false,
    });

    if (operationType === 'Mutation') {
      return `
export function use${operationName}() {
  return Urql.use${operationType}<${operationResultType}, ${operationVariablesTypes}>(${documentVariableName});
};`;
    }

    if (operationType === 'Subscription') {
      return `
export function use${operationName}<TData = ${operationResultType}>(options: Omit<Urql.Use${operationType}Args<${operationVariablesTypes}>, 'query'> = {}, handler?: Urql.SubscriptionHandler<${operationResultType}, TData>) {
  return Urql.use${operationType}<${operationResultType}, TData, ${operationVariablesTypes}>({ query: ${documentVariableName}, ...options }, handler);
};`;
    }

    const isVariablesRequired = node.variableDefinitions.some(
      variableDef => variableDef.type.kind === Kind.NON_NULL_TYPE && variableDef.defaultValue == null
    );

    return `
export function use${operationName}(options${
      isVariablesRequired ? '' : '?'
    }: Omit<Urql.Use${operationType}Args<${operationVariablesTypes}>, 'query'>) {
  return Urql.use${operationType}<${operationResultType}, ${operationVariablesTypes}>({ query: ${documentVariableName}, ...options });
};`;
  }

  private _buildLoaders(
    node: OperationDefinitionNode,
    operationType: string,
    documentVariableName: string,
    operationResultType: string,
    operationVariablesTypes: string
  ): string {
    const operationName: string = this.convertName(node.name?.value ?? '', {
      suffix: this.getOperationSuffix(node, operationType),
      useTypesPrefix: false,
    });
    const promiseLike = t => `${t} | PromiseLike<${t}>`;
    const factory = t => `${t} | ((args: ReactRouter.ActionFunctionArgs) => ${promiseLike(t)})`;
    const options = `${factory(`(Partial<Urql.OperationContext> & { variables?: ${operationVariablesTypes} })`)}`;

    if (operationType === 'Mutation') {
      return `
export function use${operationName}ActionData(){
  return ReactRouter.useActionData() as undefined | null | Awaited<ReturnType<ReturnType<typeof ${operationName}Action>>>
}

export function ${operationName}Action(options?: ${options}) {
  return async function action(args: ReactRouter.ActionFunctionArgs){
    const ctx = await (typeof options === 'function' ? options(args) : options)
    const variables = 'variables' in ctx ? ctx.variables : await parseAction(args)
    return client.mutation<${operationResultType}, ${operationVariablesTypes}>(${documentVariableName}, variables, ctx).toPromise();
  }
};`;
    }
    if (operationType === 'Subscription') {
      return ``;
    }
    const isVariablesRequired = node.variableDefinitions.some(
      variableDef => variableDef.type.kind === Kind.NON_NULL_TYPE && variableDef.defaultValue == null
    );

    return `
export function use${operationName}LoaderData(){
  return ReactRouter.useLoaderData() as Awaited<ReturnType<ReturnType<typeof ${operationName}Loader>>>
}
export function ${operationName}Loader(options?: ${options}) {
  return async function loader(args: ReactRouter.LoaderFunctionArgs){
    const ctx = await (typeof options === 'function' ? options(args) : options)
    const variables = 'variables' in ctx ? ctx.variables : await parseLoader(args)
    return client.query<${operationResultType}, ${operationVariablesTypes}>(${documentVariableName}, variables, { ...ctx, fetchOptions: { signal: args.request.signal, ...ctx.fetchOptions } }).toPromise();
    }
  };`;
  }

  protected buildOperation(
    node: OperationDefinitionNode,
    documentVariableName: string,
    operationType: string,
    operationResultType: string,
    operationVariablesTypes: string
  ): string {
    const documentVariablePrefixed = this._externalImportPrefix + documentVariableName;
    const operationResultTypePrefixed = this._externalImportPrefix + operationResultType;
    const operationVariablesTypesPrefixed = this._externalImportPrefix + operationVariablesTypes;

    const component = this.config.withComponent
      ? this._buildComponent(
          node,
          documentVariablePrefixed,
          operationType,
          operationResultTypePrefixed,
          operationVariablesTypesPrefixed
        )
      : null;
    const hooks = this.config.withHooks
      ? this._buildHooks(
          node,
          operationType,
          documentVariablePrefixed,
          operationResultTypePrefixed,
          operationVariablesTypesPrefixed
        )
      : null;

    const loaders = this.config.withLoaders
      ? this._buildLoaders(
          node,
          operationType,
          documentVariablePrefixed,
          operationResultTypePrefixed,
          operationVariablesTypesPrefixed
        )
      : null;

    return [component, hooks, loaders].filter(a => a).join('\n');
  }
}
