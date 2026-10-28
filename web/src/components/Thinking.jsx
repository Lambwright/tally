import Loader from "./Loader.jsx";

// "Working on it" with something specific to say (`label`): the suite's shared loading animation, with that text.
export default function Thinking({ label, size = 120 }) {
  return <Loader text={label} size={size} />;
}
