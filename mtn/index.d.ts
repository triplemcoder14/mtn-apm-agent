import type apm from '../index';

declare namespace mtnApm {
  export interface Agent {
    start(options?: AgentOptions): Agent;
    isStarted(): boolean;


    startOperation(
      name?: string | null,
      options?: OperationOptions,
    ): Operation;

    currentOperation: Operation | null;

    endOperation(result?: string | number): void;

    startStep(
      name?: string | null,
      options?: StepOptions,
    ): Step | null;

    currentStep: Step | null;

    reportError(
      error: Error | string,
      options?: ErrorOptions,
    ): void;

    setAttributes(attributes: Attributes): void;
    setUser(user: User): void;

    flush(): Promise<void>;
    shutdown(): Promise<void>;
  }
}

type Operation = apm.Transaction;
type Step = apm.Span;

type Attributes = Record<string, string | number | boolean | null>;

type User = {
  id?: string | number;
  username?: string;
  email?: string;
};

interface AgentOptions extends apm.AgentConfigOptions {}
interface OperationOptions extends apm.TransactionOptions {}
interface StepOptions extends apm.SpanOptions {}
interface ErrorOptions extends apm.CaptureErrorOptions {}

declare const mtn: mtnApm.Agent;
export = mtn;
