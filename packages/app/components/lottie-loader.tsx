import { Suspense, lazy } from "react";
import { View } from "react-native";
import loaderAnimation from "../assets/loader-three-dots.json";

/**
 * On web, `lottie-react-native` resolves to `@lottiefiles/dotlottie-react` and
 * with it `@lottiefiles/dotlottie-web` — 169,648 B measured in `index-*.js`,
 * for a three-dot "thinking" indicator that appears only once a turn is already
 * running. Behind `lazy()` Metro emits it as its own chunk instead (verified in
 * `docs/bundle-baseline.mdx`: the entry chunk drops by that amount and a
 * `lottie-loader-*.js` chunk appears).
 *
 * The fallback is the same box at the same size, so nothing reflows while the
 * chunk arrives, and nothing that renders at first paint uses this component.
 */
const LottieView = lazy(() => import("lottie-react-native"));

export const LottieLoader = ({ width = 60, height = 60 }) => (
  <View
    className="ml-0"
    style={{
      width: width,
      height: height,
      alignItems: "flex-start",
      justifyContent: "flex-start",
    }}
  >
    <Suspense fallback={null}>
      <LottieView
        source={loaderAnimation}
        autoPlay
        loop
        style={{ width: "100%", height: "100%" }}
      />
    </Suspense>
  </View>
);
