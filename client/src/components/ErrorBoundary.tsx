import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error?: Error }

/** 顶层错误边界：任何渲染异常都显示可读信息而不是整屏白屏。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: unknown): void { console.error('[UI error boundary]', error, info); }
  render() {
    if (this.state.error) {
      return (
        <main className="page-error" role="alert">
          <h1>界面出错了</h1>
          <p className="error-message">{String(this.state.error?.message ?? this.state.error)}</p>
          <div className="button-group">
            <button className="primary-button" type="button" onClick={() => this.setState({ error: undefined })}>重试</button>
            <button className="text-button" type="button" onClick={() => window.location.reload()}>重新加载</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
