/// <reference types="nativewind/types" />

/**
 * NativeWind className augmentations for React Native components.
 *
 * The triple-slash reference above loads react-native-css-interop's module
 * augmentation, but in monorepo setups TypeScript can resolve the `react-native`
 * module from a different node_modules copy than the augmentation targets.
 * These inline declarations ensure className is always recognized.
 *
 * @see https://www.nativewind.dev/getting-started/typescript
 */
import 'react-native';

declare module 'react-native' {
  interface ViewProps {
    className?: string;
  }
  interface TextProps {
    className?: string;
  }
  interface ImagePropsBase {
    className?: string;
  }
  interface TextInputProps {
    className?: string;
    placeholderClassName?: string;
  }
  interface SwitchProps {
    className?: string;
  }
  interface TouchableWithoutFeedbackProps {
    className?: string;
  }
  interface PressableProps {
    className?: string;
  }
  interface ScrollViewProps {
    className?: string;
    contentContainerClassName?: string;
    indicatorClassName?: string;
  }
  interface FlatListProps<ItemT> {
    className?: string;
    columnWrapperClassName?: string;
  }
  interface StatusBarProps {
    className?: string;
  }
  interface InputAccessoryViewProps {
    className?: string;
  }
  interface KeyboardAvoidingViewProps {
    contentContainerClassName?: string;
  }
  interface ModalBaseProps {
    presentationClassName?: string;
  }
}
