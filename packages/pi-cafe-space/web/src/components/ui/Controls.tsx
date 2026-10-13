import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Button as ShadcnButton } from './shadcn/button';
import { Tooltip } from './Tooltip';
import { BusyLabel } from './Icon';
export { Input } from './shadcn/input';
export { Textarea } from './shadcn/textarea';
export { Label } from './shadcn/label';
// Preserve business callers' loading/variant contract; all styling and
// interaction primitives live in the local shadcn sources.
export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  variant?: 'primary' | 'quiet';
  loading?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, loading, disabled, type = 'button', children, ...props }, ref) {
  return <ShadcnButton {...props} ref={ref} type={type} variant={variant === 'primary' ? 'default' : variant === 'quiet' ? 'ghost' : 'secondary'}
    disabled={disabled || loading} aria-busy={loading ?? props['aria-busy']}>
    {loading === undefined ? children : <BusyLabel>{children}</BusyLabel>}
  </ShadcnButton>;
});
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton({ label, variant, loading, disabled, children, ...props }, ref) {
  return <Tooltip label={label}><ShadcnButton {...props} ref={ref} type={props.type ?? 'button'} aria-label={label} size="icon"
    variant={variant === 'primary' ? 'default' : 'ghost'} disabled={disabled || loading} aria-busy={loading}>
    {loading === undefined ? children : <BusyLabel>{children}</BusyLabel>}
  </ShadcnButton></Tooltip>;
});
