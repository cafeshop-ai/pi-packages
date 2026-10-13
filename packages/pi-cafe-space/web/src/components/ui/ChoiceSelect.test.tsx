import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChoiceSelect } from './ChoiceSelect';
import { UiProvider } from './UiProvider';

it('native mode commits an actual selected value once without a floating portal',()=>{
 const change=vi.fn();const {rerender}=render(<UiProvider><ChoiceSelect native label="Thinking" value="off" items={[{value:'off',label:'off'},{value:'high',label:'high'}]} onValueChange={change}/></UiProvider>);const input=screen.getByRole('combobox',{name:'Thinking'});expect(input.tagName).toBe('SELECT');fireEvent.change(input,{target:{value:'high'}});expect(change).toHaveBeenCalledExactlyOnceWith('high');expect(document.querySelector('[data-slot="select-content"]')).toBeNull();rerender(<UiProvider><ChoiceSelect native label="Thinking" value="high" disabled items={[{value:'high',label:'high'}]} onValueChange={change}/></UiProvider>);expect(input).toHaveValue('high');expect(input).toBeDisabled();
});
// Floating UI needs browser geometry. Open/select/keyboard/CSP and real Gateway
// payload checks live in cafe-ui-browser.mjs --shadcn, not a JSDOM layout mock.
it('renders an accessible shadcn trigger with empty selection and a disabled state', () => {
  const change = vi.fn();
  const props = { label: 'Delivery', value: '', items: [{ value: '', label: 'Choose delivery' }, { value: 'steer', label: 'Steer' }], onValueChange: change };
  const { rerender } = render(<UiProvider><ChoiceSelect {...props} /></UiProvider>);
  const trigger = screen.getByRole('combobox', { name: 'Delivery' });
  expect(trigger.tagName).toBe('BUTTON'); expect(trigger).toHaveTextContent('Choose delivery');
  expect(trigger).toHaveAttribute('data-slot', 'select-trigger');
  expect(trigger.closest('[data-slot="field"]')).toHaveAttribute('data-orientation', 'horizontal');
  expect(screen.getByLabelText('Delivery')).toBe(trigger);
  rerender(<UiProvider><ChoiceSelect {...props} disabled /></UiProvider>);
  expect(trigger).toBeDisabled(); expect(change).not.toHaveBeenCalled();
  expect(document.querySelectorAll('style')).toHaveLength(0);
});
