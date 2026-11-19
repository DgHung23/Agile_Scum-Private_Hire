import { Link } from 'react-router-dom';
import { Empty } from '../ui.jsx';

/** Placeholder for pages scheduled in a later sprint (removed as modules are delivered). */
export default function ComingSoon({ title = 'Coming soon' }) {
  return (
    <div className="container page">
      <Empty icon="clock" title={title} action={<Link to="/" className="btn">Back to home</Link>}>
        This part of Private Hire is being built in an upcoming sprint.
      </Empty>
    </div>
  );
}
