export declare namespace AwsLambda {
  interface CognitoIdentity {
    cognitoIdentityId: string;
    cognitoIdentityPoolId: string;
  }

  interface ClientContext {
    client: ClientContextClient;
    custom?: any;
    env: ClientContextEnv;
  }

  interface ClientContextClient {
    installationId: string;
    appTitle: string;
    appVersionName: string;
    appVersionCode: string;
    appPackageName: string;
  }

  interface ClientContextEnv {
    platformVersion: string;
    platform: string;
    make: string;
    model: string;
    locale: string;
  }

  type Callback<TResult = any> = (
    error?: Error | null | string,
    result?: TResult,
  ) => void;

  interface Context {
    // Properties
    callbackWaitsForEmptyEventLoop: boolean;
    functionName: string;
    functionVersion: string;
    invokedFunctionArn: string;
    memoryLimitInMB: string;
    awsRequestId: string;
    logGroupName: string;
    logStreamName: string;
    identity?: CognitoIdentity;
    clientContext?: ClientContext;

    // Functions
    getRemainingTimeInMillis(): number;

    done(error?: Error, result?: any): void;
    fail(error: Error | string): void;
    succeed(messageOrObject: any): void;
    succeed(message: string, object: any): void;
  }

  type Handler<TEvent = any, TResult = any> = (
    event: TEvent,
    context: Context,
    callback: Callback<TResult>,
  ) => void | Promise<TResult>;
}
